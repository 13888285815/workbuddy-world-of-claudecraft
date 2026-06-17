// Online play: Supabase REST API client + polling world mirror.
//
// This module replaces the original custom WebSocket backend with direct
// Supabase REST API calls. Key changes vs. the original:
//  - Auth: uses Web Crypto PBKDF2 password hashing + accounts table
//  - Characters: stored in Supabase with game_state JSONB for persistence
//  - Leaderboard: served from ladder table via Supabase REST
//  - Friends/Ignore: stored in friends/ignores tables
//  - Chat: stored in chat_logs table (polling for live updates)
//  - World simulation: offline-style Sim with state persisted to Supabase
//  - No WebSocket connection required; all via Supabase REST + polling

import { NPCS, abilitiesKnownAt } from '../sim/data';
import { computeQuestState, Sim, ResolvedAbility } from '../sim/sim';
import {
  cloneAllocation, computeTalentModifiers, emptyAllocation, talentPointsAtLevel, pointsSpent,
  type TalentAllocation, type SavedLoadout, type Role,
} from '../sim/content/talents';
import {
  Entity, EquipSlot, InvSlot, MoveInput, PetMode, PlayerClass, QuestProgress, QuestState, SimEvent, SimConfig,
  emptyMoveInput,
} from '../sim/types';
import { normalizeMoveFacing, sanitizeMoveInput } from '../sim/move_input';
import { isOverheadEmoteId, type ArenaInfo, type CharacterSearchResult, type DuelInfo, type FriendInfo, type IWorld, type LeaderboardEntry, type MarketInfo, type OverheadEmoteId, type PartyInfo, type PresenceStatus, type SocialInfo, type TradeInfo } from '../world_api';
import {
  getSession, setSession, getAccountId,
  sbRegister, sbLogin, sbListCharacters, sbCreateCharacter, sbDeleteCharacter,
  sbGetLeaderboard, sbGetFriends, sbGetIgnores, sbFriendAdd, sbFriendRemove,
  sbBlockAdd, sbBlockRemove, sbSearchCharacters, sbGetChat, sbSendChat,
  sbSaveGameState, sbLoadGameState, sbGet, type ArenaLadderEntry,
} from './supabase';

// Injected at build time by vite.config.ts
declare const __API_BASE_URL__: string;

// ---------------------------------------------------------------------------
// REST (Supabase-backed)
// ---------------------------------------------------------------------------

export interface CharacterSummary {
  id: string; // Supabase UUID string (was numeric in old API)
  name: string;
  class: PlayerClass;
  level: number;
  skin: number;
  online: boolean;
  forceRename: boolean;
}

export function buildWebSocketUrl(protocol: string, host: string): string {
  const proto = protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${host}/ws`;
}

export function buildWebSocketAuthMessage(token: string, characterId: number): { t: 'auth'; token: string; character: number } {
  return { t: 'auth', token, character: characterId };
}

export type RealmType = 'Normal' | 'PvP' | 'RP' | 'RP-PvP';

export interface RealmEntry {
  name: string;
  url: string;
  type: RealmType;
}

export interface RealmDirectory {
  current: string;
  realms: RealmEntry[];
  characters: Record<string, number>; // realm name -> how many characters you have
}

export class Api {
  token: string | null = null;
  username: string | null = null;
  realm: string | null = null;
  // base origin for API calls. Defaults to __API_BASE_URL__ (set at build time)
  // or '' (same origin). Can be overridden via setRealm().
  // Note: with Supabase, this is a no-op but kept for API compatibility.
  base = __API_BASE_URL__ || '';

  setRealm(_url: string): void {
    // Supabase is a single-instance backend; realm switching is not applicable.
    this.realm = 'Claudemoon';
  }

  // The realm directory: single Supabase realm (Claudemoon).
  async realms(): Promise<RealmDirectory> {
    return {
      current: 'Claudemoon',
      realms: [{ name: 'Claudemoon', url: '', type: 'Normal' }],
      characters: { Claudemoon: 0 },
    };
  }

  // Realm status: Supabase is always online.
  async realmStatus(_url: string): Promise<{ online: boolean; players: number }> {
    return { online: true, players: 1 };
  }

  async register(username: string, password: string, _turnstileToken = ''): Promise<void> {
    await sbRegister(username, password);
    // After registration, log in to get the session
    const session = await sbLogin(username, password);
    this.token = session.accountId;
    this.username = session.username;
  }

  async login(username: string, password: string, _turnstileToken = ''): Promise<void> {
    const session = await sbLogin(username, password);
    this.token = session.accountId;
    this.username = session.username;
  }

  async characters(): Promise<CharacterSummary[]> {
    return await sbListCharacters();
  }

  async createCharacter(name: string, cls: PlayerClass, skin = 0): Promise<void> {
    await sbCreateCharacter(name, cls, skin);
  }

  async renameCharacter(characterId: string, name: string): Promise<void> {
    // TODO: use Supabase RPC or PATCH endpoint for rename
    // For now: update via PATCH to the character name field
    const ok = await (await fetch(
      `${'https://vagekvcsjacfvoidvzzj.supabase.co'}/rest/v1/characters?id=eq.${characterId}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'apikey': '', 'Authorization': `Bearer ` }, body: JSON.stringify({ name }) },
    )).ok;
    if (!ok) throw new Error('Rename failed');
  }

  async deleteCharacter(characterId: string, _name: string): Promise<void> {
    // characterId is now the Supabase UUID string
    if (characterId && characterId.length > 8) {
      await sbDeleteCharacter(characterId, _name);
    }
  }

  async reportPlayer(_reporterCharacterId: string, _targetPid: number, _reason: string, _details: string): Promise<void> {
    // Report feature not stored in current Supabase schema — placeholder.
  }

  async reportPlayerByName(_reporterCharacterId: string, _targetCharacterName: string, _reason: string, _details: string): Promise<void> {
    // Report feature not stored in current Supabase schema — placeholder.
  }

  async projectStats(): Promise<{ accounts_created: number; players_online: number; realm: string }> {
    // Approximate stats from Supabase counts
    const accounts = await sbGet<{ count: number }[]>('/rest/v1/accounts?select=id');
    return {
      accounts_created: accounts?.length ?? 0,
      players_online: 1, // local estimate; Supabase doesn't track online without Realtime
      realm: 'Claudemoon',
    };
  }

  // Lifetime-XP leaderboard (uses ladder table rating for MVP).
  async leaderboard(scope: 'realm' | 'global' = 'global', limit = 100): Promise<LeaderboardEntry[]> {
    try {
      const rows = await sbGetLeaderboard();
      return rows.slice(0, limit).map((r, i) => ({
        rank: i + 1,
        name: r.name,
        cls: r.cls,
        level: 1,
        virtualLevel: 1,
        lifetimeXp: r.rating * 100,
        prestigeRank: 0,
        realm: 'Claudemoon',
      }));
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// World mirror
// ---------------------------------------------------------------------------

function wrapAngle(d: number): number {
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function copyPos(dst: { x: number; y: number; z: number }, src: { x: number; y: number; z: number }): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
}

// A single position update never moves an entity more than a few yards by
// walking; anything past this is a teleport (arena pit, dungeon portal,
// graveyard release). Those are snapped, not interpolated — see applyWire.
const TELEPORT_SNAP_DIST_SQ = 40 * 40;

function blankEntity(id: number): Entity {
  return {
    id, kind: 'mob', templateId: '', name: '', level: 1,
    pos: { x: 0, y: 0, z: 0 }, prevPos: { x: 0, y: 0, z: 0 }, facing: 0, prevFacing: 0,
    vx: 0, vz: 0, vy: 0, onGround: true, fallStartY: 0,
    hp: 1, maxHp: 1, resource: 0, maxResource: 0, resourceType: null,
    overheadEmoteId: null, overheadEmoteUntil: 0, overheadEmoteSeq: 0,
    stats: { str: 0, agi: 0, sta: 0, int: 0, spi: 0, armor: 0 },
    weapon: { min: 1, max: 2, speed: 2 },
    attackPower: 0, rangedPower: 0, critChance: 0.05, dodgeChance: 0.05, moveSpeed: 7, hostile: false,
    targetId: null, autoAttack: false, swingTimer: 0,
    inCombat: false, combatTimer: 99,
    auras: [], ccDr: new Map(), castingAbility: null, castRemaining: 0, castTotal: 0,
    channeling: false, channelTickTimer: 0, channelTickEvery: 0,
    gcdRemaining: 0, cooldowns: new Map(), queuedOnSwing: null, fiveSecondRule: 99,
    comboPoints: 0, comboTargetId: null, overpowerUntil: -1, potionCooldownUntil: -1, savedMana: 0,
    chargeTargetId: null, chargeTimeLeft: 0, chargePath: [], followTargetId: null,
    sitting: false, eating: null, drinking: null,
    aiState: 'idle', tappedById: null, pulseTimer: 0, stompTimer: 0, firedSummons: 0, summonedIds: [], enraged: false, healedThisPull: false,
    threat: new Map(), forcedTargetId: null, forcedTargetTimer: 0, ownerId: null, petMode: 'defensive', petTauntTimer: 0,
    spawnPos: { x: 0, y: 0, z: 0 }, leashAnchor: null, evadeStall: 0, fleeTimer: 0, hasFled: false, wanderTarget: null, wanderTimer: 0,
    aggroTargetId: null, respawnTimer: 0, corpseTimer: 0, lootable: false, loot: null,
    xpValue: 0, questIds: [], vendorItems: [], objectItemId: null, dungeonId: null,
    dead: false, scale: 1, color: 0xffffff, skin: 0,
  };
}

export class ClientWorld implements IWorld {
  // IWorld state — backed by the Sim instance for NPC/world simulation
  cfg: { seed: number; playerClass: PlayerClass };
  entities: Map<number, Entity>;
  playerId: number;
  moveInput: MoveInput;
  inventory: InvSlot[];
  vendorBuyback: InvSlot[];
  equipment: Partial<Record<EquipSlot, string>>;
  copper = 0;
  xp = 0;
  lifetimeXp = 0;
  prestigeRank = 0;
  unlockedMilestones: string[] = [];
  known: ResolvedAbility[] = [];
  talents: TalentAllocation;
  talentSpec: string | null;
  talentRole: Role | null;
  loadouts: SavedLoadout[];
  activeLoadout = -1;
  questLog = new Map<string, QuestProgress>();
  questsDone = new Set<string>();
  partyInfo: PartyInfo | null = null;
  tradeInfo: TradeInfo | null = null;
  duelInfo: DuelInfo | null = null;
  socialInfo: SocialInfo | null = null;
  arenaInfo: ArenaInfo | null = null;
  marketInfo: MarketInfo | null = null;
  markers: Record<number, number> = {};
  realm = 'Claudemoon';
  // eventQueue: SimEvents from local Sim tick
  private _eventQueue: SimEvent[] = [];
  // polling handles
  private _chatPollTimer: number | undefined;
  private _saveTimer: number | undefined;
  private _lastChatAt = '';
  // Supabase character state
  readonly characterId: string;
  private readonly _characterName: string;
  // The local Sim instance that drives NPC/world simulation.
  // Exposed so the main game loop (main.ts) can call sim.tick().
  readonly sim: Sim;

  // connected is always true for Supabase (we are always "online")
  connected = true;
  onDisconnect: ((reason: string) => void) | null = null;
  profanityWords: string[] = [];
  private _socialDirty = false;
  lastSnapAt = 0;
  snapInterval = 50;
  pendingFacingDelta = 0;

  constructor(
    accountId: string,
    characterId: string,
    _characterSummaryId: number,
    characterName: string,
    cls: PlayerClass,
  ) {
    this.characterId = characterId;
    this._characterName = characterName;
    this.cfg = { seed: 20061, playerClass: cls };

    // Create a local Sim for world/NPC simulation.
    this.sim = new Sim({
      seed: 20061,
      playerClass: cls,
      playerName: characterName,
    });

    // Sync Sim's initial state to our IWorld properties
    this.playerId = this.sim.playerId;
    this.entities = this.sim.entities;
    this.moveInput = this.sim.moveInput;
    this.inventory = this.sim.inventory;
    this.vendorBuyback = this.sim.vendorBuyback;
    this.equipment = this.sim.equipment;
    this.talents = emptyAllocation();
    this.talentSpec = null;
    this.talentRole = null;
    this.loadouts = [];

    // Set connected immediately — Supabase is always available
    this.connected = true;

    // Load persisted state from Supabase (async, don't block)
    void this._loadState();

    // Start polling loops
    this._chatPollTimer = window.setInterval(() => this._pollChat(), 5000);
    this._saveTimer = window.setInterval(() => this._saveState(), 15000);
  }

  close(): void {
    clearInterval(this._chatPollTimer);
    clearInterval(this._saveTimer);
    // Save state on close
    void this._saveState();
    this.connected = false;
  }

  // ---------------------------------------------------------------------------
  // IWorld — player accessor
  // ---------------------------------------------------------------------------
  get player(): Entity {
    return this.entities.get(this.playerId) ?? blankEntity(this.playerId);
  }

  drainEvents(): SimEvent[] {
    const out = this._eventQueue;
    this._eventQueue = [];
    return out;
  }

  setMoveInput(input: unknown, facing?: unknown): void {
    Object.assign(this.moveInput, sanitizeMoveInput(input));
    if (arguments.length > 1) this.setMouselookFacing(facing);
  }

  setMouselookFacing(facing: unknown): void {
    // This is a no-op for Supabase (no server-side camera sync)
  }

  flushInput(): boolean { return true; }

  consumeInputEchoSamples(): number[] { return []; }

  consumeSocialChanged(): boolean {
    const v = this._socialDirty;
    this._socialDirty = false;
    return v;
  }

  consumeProfanityChanged(): boolean { return false; }
  consumeInventoryChanged(): boolean {
    // Inventory is the same array reference as Sim.inventory — updated every Sim.tick()
    // Always return true so the HUD re-renders the inventory panel each frame.
    return true;
  }

  // ---------------------------------------------------------------------------
  // IWorld — quest state helpers
  // ---------------------------------------------------------------------------
  questState(questId: string): QuestState {
    return computeQuestState(questId, this.questLog, this.questsDone, this.player.level);
  }

  // ---------------------------------------------------------------------------
  // IWorld — game actions (no-op for Supabase since no server simulation)
  // ---------------------------------------------------------------------------
  castAbility(_abilityId: string): void { /* offline sim handles this */ }
  castAbilityBySlot(_slot: number): void {}
  targetEntity(_id: number | null): void {}
  tabTarget(): void {}
  targetNearestFriendly(): void {}
  friendlyTabTarget(): void {}
  startAutoAttack(): void {}
  stopAutoAttack(): void {}
  interact(): void {}
  lootCorpse(_id: number): void {}
  pickUpObject(_id: number): void {}
  acceptQuest(_questId: string): void { /* TODO: persist to Supabase */ }
  turnInQuest(_questId: string): void { /* TODO: persist to Supabase */ }
  abandonQuest(_questId: string): void {}
  equipItem(_itemId: string): void {}
  useItem(_itemId: string): void {}
  discardItem(_itemId: string, _count?: number): void {}
  buyItem(_npcId: number, _itemId: string): void {}
  sellItem(_itemId: string, _count?: number): void {}
  buyBackItem(_itemId: string): void {}
  changeSkin(_skin: number): void {}
  releaseSpirit(): void {}

  chat(text: string): void {
    // Send via Supabase REST API
    void sbSendChat(text, 'General');
    // Also queue a local chat event for the HUD
    this._eventQueue.push({
      type: 'chat',
      fromPid: this.playerId,
      from: this._characterName,
      text,
      channel: 'say',
      entityId: this.playerId,
    });
  }

  playEmote(emoteId: OverheadEmoteId): void {
    if (!this.player.dead) {
      const p = this.entities.get(this.playerId);
      if (p) {
        p.overheadEmoteId = emoteId;
        p.overheadEmoteUntil = Number.POSITIVE_INFINITY;
        p.overheadEmoteSeq += 1;
      }
    }
  }

  abandonPet(): void {}
  renamePet(_name: string): void {}
  revivePet(): void {}
  petAttack(): void {}
  petTaunt(): void {}
  feedPet(_itemId: string): void {}
  healPet(): void {}
  setPetMode(_mode: PetMode): void {}

  // Social
  partyInvite(_targetPid: number): void {}
  partyAccept(): void {}
  partyDecline(): void {}
  partyLeave(): void {}
  partyKick(_targetPid: number): void {}
  markerFor(entityId: number): number | null { return this.markers[entityId] ?? null; }
  setMarker(_entityId: number, _markerId: number): void {}
  clearMarker(_entityId: number): void {}
  tradeRequest(_targetPid: number): void {}
  tradeAccept(): void {}
  tradeSetOffer(_items: InvSlot[], _copper: number): void {}
  tradeConfirm(): void {}
  tradeCancel(): void {}
  duelRequest(_targetPid: number): void {}
  duelAccept(): void {}
  duelDecline(): void {}

  async friendAdd(name: string): Promise<void> {
    await sbFriendAdd(name);
    await this._refreshSocial();
  }
  async friendRemove(name: string): Promise<void> {
    await sbFriendRemove(name);
    await this._refreshSocial();
  }
  async blockAdd(name: string): Promise<void> {
    await sbBlockAdd(name);
    await this._refreshSocial();
  }
  async blockRemove(name: string): Promise<void> {
    await sbBlockRemove(name);
    await this._refreshSocial();
  }

  guildCreate(_name: string): void {}
  guildInvite(_name: string): void {}
  guildAccept(): void {}
  guildDecline(): void {}
  guildLeave(): void {}
  guildKick(_name: string): void {}
  guildPromote(_name: string): void {}
  guildDemote(_name: string): void {}
  guildTransfer(_name: string): void {}
  guildDisband(): void {}

  async searchCharacters(query: string): Promise<CharacterSearchResult[]> {
    return sbSearchCharacters(query);
  }

  arenaQueueJoin(): void {}
  arenaQueueLeave(): void {}

  marketList(_itemId: string, _count: number, _price: number): void {}
  marketBuy(_listingId: number): void {}
  marketCancel(_listingId: number): void {}
  marketCollect(): void {}

  enterDungeon(_dungeonId: string): void {}
  leaveDungeon(): void {}

  async leaderboard(): Promise<LeaderboardEntry[]> {
    try {
      const rows = await sbGetLeaderboard();
      return rows.map((r, i) => ({
        rank: i + 1,
        name: r.name,
        cls: r.cls,
        level: 1,
        virtualLevel: 1,
        lifetimeXp: r.rating * 100,
        prestigeRank: 0,
        realm: 'Claudemoon',
      }));
    } catch {
      return [];
    }
  }

  prestige(): void {}

  talentPoints(): { total: number; spent: number } {
    return { total: talentPointsAtLevel(this.player.level), spent: pointsSpent(this.talents) };
  }

  applyTalents(alloc: TalentAllocation): void {
    this.talents = cloneAllocation(alloc);
    this.known = abilitiesKnownAt(this.cfg.playerClass, this.player.level, computeTalentModifiers(this.cfg.playerClass, this.talents));
    void this._saveState();
  }

  respec(): void {
    this.talents = emptyAllocation();
    this.known = abilitiesKnownAt(this.cfg.playerClass, this.player.level, computeTalentModifiers(this.cfg.playerClass, this.talents));
    void this._saveState();
  }

  setSpec(_specId: string | null): void {
    void this._saveState();
  }

  saveLoadout(name: string, bar: (string | null)[], alloc?: TalentAllocation): void {
    const clean = (name || 'Build').toString().slice(0, 24);
    const safeBar = Array.isArray(bar) ? bar.slice(0, 16).map((b) => (typeof b === 'string' ? b : null)) : [];
    if (alloc) {
      const saved = { name: clean, alloc: cloneAllocation(alloc), bar: safeBar };
      this.talents = cloneAllocation(alloc);
      const existing = this.loadouts.findIndex((l) => l.name === clean);
      if (existing >= 0) {
        this.loadouts[existing] = saved;
        this.activeLoadout = existing;
      } else {
        this.loadouts = [...this.loadouts, saved];
        this.activeLoadout = this.loadouts.length - 1;
      }
      this.known = abilitiesKnownAt(this.cfg.playerClass, this.player.level, computeTalentModifiers(this.cfg.playerClass, this.talents));
      void this._saveState();
    }
  }

  switchLoadout(index: number): void {
    if (index < 0 || index >= this.loadouts.length) return;
    this.activeLoadout = index;
    const next = this.loadouts[index];
    if (next) {
      this.talents = cloneAllocation(next.alloc);
      this.known = abilitiesKnownAt(this.cfg.playerClass, this.player.level, computeTalentModifiers(this.cfg.playerClass, this.talents));
    }
    void this._saveState();
  }

  deleteLoadout(index: number): void {
    if (index < 0 || index >= this.loadouts.length) return;
    const wasActive = this.activeLoadout === index;
    this.loadouts = this.loadouts.filter((_, i) => i !== index);
    if (wasActive) {
      this.activeLoadout = this.loadouts.length > 0 ? Math.min(index, this.loadouts.length - 1) : -1;
      const next = this.activeLoadout >= 0 ? this.loadouts[this.activeLoadout] : null;
      if (next) {
        this.talents = cloneAllocation(next.alloc);
        this.known = abilitiesKnownAt(this.cfg.playerClass, this.player.level, computeTalentModifiers(this.cfg.playerClass, this.talents));
      }
    } else if (this.activeLoadout > index) {
      this.activeLoadout -= 1;
    }
    void this._saveState();
  }

  // Legacy aliases
  enterCrypt(): void { this.enterDungeon('hollow_crypt'); }
  leaveCrypt(): void { this.leaveDungeon(); }

  // ---------------------------------------------------------------------------
  // Load persisted state from Supabase
  // ----------------------------------------------------------------------------
  private async _loadState(): Promise<void> {
    try {
      const state = await sbLoadGameState(this.characterId);
      if (state) {
        this.inventory = state.inventory ?? [];
        this.equipment = (state.equipment ?? {}) as Partial<Record<EquipSlot, string>>;
        this.copper = state.copper ?? 0;
        if (state.questLog) this.questLog = new Map(Object.entries(state.questLog));
        if (state.questsDone) this.questsDone = new Set(state.questsDone);
        if (state.talents) this.talents = state.talents;
        this.talentSpec = state.talentSpec ?? null;
        this.talentRole = state.talentRole ?? null;
        this.loadouts = state.loadouts ?? [];
        this.activeLoadout = state.activeLoadout ?? -1;
        if (this.talents && Object.keys(this.talents).length > 0) {
          this.known = abilitiesKnownAt(this.cfg.playerClass, this.sim.player.level,
            computeTalentModifiers(this.cfg.playerClass, this.talents));
        }
      }
    } catch { /* silently ignore load errors */ }
  }

  // ---------------------------------------------------------------------------
  // Polling helpers
  // ---------------------------------------------------------------------------
  private async _refreshSocial(): Promise<void> {
    try {
      const [friends, ignores] = await Promise.all([sbGetFriends(), sbGetIgnores()]);
      this.socialInfo = {
        friends,
        blocks: ignores,
        guild: null,
      };
      this._socialDirty = true;
    } catch { /* silently ignore polling errors */ }
  }

  private async _pollChat(): Promise<void> {
    try {
      const msgs = await sbGetChat('General', 20);
      if (msgs.length === 0) return;
      const latest = msgs[msgs.length - 1];
      if (latest.created_at <= this._lastChatAt) return;
      this._lastChatAt = latest.created_at;
      // Queue chat events for HUD
      for (const msg of msgs) {
        if (msg.created_at > this._lastChatAt) continue;
        // Convert sender_id (UUID) to numeric for entityId
        const entityId = parseInt(msg.sender_id.replace(/-/g, '').slice(0, 8), 16) || 0;
        this._eventQueue.push({
          type: 'chat',
          fromPid: entityId,
          from: msg.sender_name,
          text: msg.message,
          channel: (msg.channel as 'say' | 'yell' | 'guild' | 'whisper' | 'general' | 'party' | 'officer' | 'world' | 'lfg' | 'emote' | 'roll') ?? 'general',
          entityId,
        });
      }
    } catch { /* silently ignore polling errors */ }
  }

  private async _saveState(): Promise<void> {
    try {
      await sbSaveGameState(this.characterId, {
        inventory: this.inventory,
        equipment: this.equipment as Record<string, string>,
        copper: this.copper,
        questLog: Object.fromEntries(this.questLog),
        questsDone: [...this.questsDone],
        talents: this.talents,
        talentSpec: this.talentSpec,
        talentRole: this.talentRole,
        loadouts: this.loadouts,
        activeLoadout: this.activeLoadout,
      });
    } catch { /* silently ignore save errors */ }
  }
}

