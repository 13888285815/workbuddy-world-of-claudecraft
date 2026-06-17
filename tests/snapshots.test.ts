import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the db layer so no Postgres is needed; snapshot logic is under test.
vi.mock('../server/db', () => ({
  pool: { query: vi.fn(async () => ({ rows: [] })) },
  saveCharacterState: vi.fn(async () => {}),
  openPlaySession: vi.fn(async () => 1),
  closePlaySession: vi.fn(async () => {}),
  insertChatLogs: vi.fn(async () => {}),
}));

import { GameServer, ClientSession } from '../server/game';
import { saveCharacterState } from '../server/db';
import { ClientWorld } from '../src/net/online';
import { abilitiesKnownAt } from '../src/sim/data';
import { computeTalentModifiers, emptyAllocation } from '../src/sim/content/talents';
import { DT, type PlayerClass } from '../src/sim/types';

const DELTA_KEYS = ['inv', 'buyback', 'equip', 'qlog', 'qdone', 'cds', 'stats', 'weapon', 'party', 'trade', 'duel'];

interface FakeClient {
  sent: any[];
  ws: any;
}

function fakeWs(): FakeClient {
  const sent: any[] = [];
  return { sent, ws: { readyState: 1, send: (payload: string) => sent.push(JSON.parse(payload)) } };
}

function lastSnap(sent: any[]): any {
  for (let i = sent.length - 1; i >= 0; i--) {
    if (sent[i].t === 'snap') return sent[i];
  }
  return null;
}

function joinServer(server: GameServer, fc: FakeClient, characterId: number, name: string, cls: PlayerClass = 'warrior'): ClientSession {
  const session = server.join(fc.ws, characterId, characterId, name, cls, null);
  if ('error' in session) throw new Error(session.error);
  session.blockListLoaded = true;
  return session;
}

function eventTexts(sent: any[]): string[] {
  return sent
    .flatMap((msg) => msg.t === 'events' ? msg.list : [])
    .filter((ev) => ev.type === 'log' || ev.type === 'error')
    .map((ev) => ev.text);
}

function broadcast(server: GameServer): void {
  (server as any).broadcastSnapshots();
}

// A ClientWorld without the WebSocket plumbing, to drive applySnapshot directly.
function blankEntity(id: number) {
  return {
    id, pos: { x: 0, y: 0, z: 0 }, prevPos: { x: 0, y: 0, z: 0 },
    facing: 0, prevFacing: 0, kind: 'player' as const, templateId: '', name: '',
    level: 1, hp: 100, maxHp: 100, dead: false, hostile: false,
    resource: 0, maxResource: 100, resourceType: 'rage' as const,
    cooldowns: new Map(), gcdRemaining: 0, comboPoints: 0, comboTargetId: null,
    targetId: null, autoAttack: false, stats: { str: 1, agi: 1, sta: 1, int: 1, spi: 1, armor: 0 },
    attackPower: 0, critChance: 0.05, dodgeChance: 0.05,
    weapon: { min: 1, max: 2, speed: 2 },
    lootable: false, overheadEmoteId: null, overheadEmoteUntil: 0, overheadEmoteSeq: 0,
    sitting: false, castingAbility: null, castRemaining: 0, castTotal: 0, channeling: false,
    aggroTargetId: null, tappedById: null, ownerId: null, petMode: 'defensive' as const, petTauntTimer: 0,
    threat: new Map(), auras: [], loot: null, skin: 0, scale: 1, color: 0xffffff, dungeonId: null,
    eating: null, drinking: null, queuedOnSwing: null, inCombat: false,
  };
}

function bareClient(pid: number): ClientWorld {
  const c: any = Object.create(ClientWorld.prototype);
  c.cfg = { seed: 20061, playerClass: 'warrior' };
  c.entities = new Map();
  c.playerId = pid;
  c.moveInput = {};
  c.inventory = [];
  c.vendorBuyback = [];
  c.equipment = {};
  c.copper = 0;
  c.xp = 0;
  c.known = [];
  c.questLog = new Map();
  c.questsDone = new Set();
  c.pendingQuestCommands = new Map();
  c.partyInfo = null;
  c.tradeInfo = null;
  c.duelInfo = null;
  c.lastSnapAt = 0;
  c.snapInterval = 50;
  c.pendingFacingDelta = 0;
  c.connected = true;
  c.eventQueue = [];
  c.mouselookFacing = null;
  c.lastInputSentAt = 0;
  c.lastInputSig = '';
  c.inputSeq = 0;
  c.pendingInputSeqSentAt = new Map();
  c.ackedInputSeq = 0;
  c.inputEchoSamples = [];
  c.talents = emptyAllocation();
  c.talentSpec = null;
  c.talentRole = null;
  c.loadouts = [];
  c.activeLoadout = -1;
  c.invChanged = false;

  // Flush movement input over the ws mock
  c.flushInput = function(now: number): boolean {
    const mi = this.moveInput;
    const sig = [mi.forward?1:0, mi.back?1:0, mi.turnLeft?1:0, mi.turnRight?1:0, mi.strafeLeft?1:0, mi.strafeRight?1:0, mi.jump?1:0].join(',');
    if (sig === this.lastInputSig) return false;
    if (now - this.lastInputSentAt < 16) return false;
    this.ws.send(JSON.stringify({ t: 'input', seq: ++this.inputSeq, mi: {
      f: mi.forward?1:0, b: mi.back?1:0, tl: mi.turnLeft?1:0, tr: mi.turnRight?1:0,
      sl: mi.strafeLeft?1:0, sr: mi.strafeRight?1:0, j: mi.jump?1:0,
    }}));
    this.lastInputSentAt = now;
    this.lastInputSig = sig;
    this.pendingInputSeqSentAt.set(this.inputSeq, now);
    return true;
  };

  // Apply a server snapshot (simplified from the old WebSocket-era applySnapshot)
  c.applySnapshot = function(snap: any): void {
    const now = (globalThis as any).performance?.now?.() ?? 0;
    if (this.lastSnapAt > 0) {
      const gap = now - this.lastSnapAt;
      if (gap > 5 && gap < 500) this.snapInterval = this.snapInterval * 0.9 + gap * 0.1;
    }
    this.lastSnapAt = now;

    const seen = new Set<number>();

    const applyWire = (w: any): any => {
      let e = this.entities.get(w.id);
      const hasIdentity = w.k !== undefined;
      if (!e) {
        if (!hasIdentity) return null;
        e = blankEntity(w.id);
        e.pos = { x: w.x, y: w.y, z: w.z };
        e.prevPos = { ...e.pos };
        e.facing = w.f;
        e.prevFacing = w.f;
        this.entities.set(w.id, e);
      }
      if (hasIdentity) {
        e.kind = w.k; e.templateId = w.tid ?? ''; e.name = w.nm ?? ''; e.level = w.lv ?? 1;
      }
      const wasDead = e.dead;
      const nowDead = !!w.dead;
      // Teleport snap or respawn snap
      const teleDx = w.x - e.pos.x, teleDz = w.z - e.pos.z;
      if ((wasDead && !nowDead) || teleDx*teleDx + teleDz*teleDz > 400) {
        e.prevPos = { x: w.x, y: w.y, z: w.z };
        e.prevFacing = w.f;
      }
      e.pos.x = w.x; e.pos.y = w.y; e.pos.z = w.z; e.facing = w.f;
      e.hp = w.hp; e.maxHp = w.mhp; e.dead = nowDead; e.hostile = !!w.h;
      return e;
    };

    for (const w of snap.ents ?? []) { if (applyWire(w)) seen.add(w.id); }

    const s = snap.self;
    if (s) {
      const e = applyWire(s);
      if (e) {
        seen.add(s.id);
        // Input ack → latency samples
        if (typeof s.ack === 'number' && s.ack > this.ackedInputSeq) {
          for (let seq = this.ackedInputSeq + 1; seq <= s.ack; seq++) {
            const sentAt = this.pendingInputSeqSentAt.get(seq);
            if (sentAt !== undefined) {
              this.inputEchoSamples.push(now - sentAt);
              this.pendingInputSeqSentAt.delete(seq);
            }
          }
          this.ackedInputSeq = s.ack;
        }
        e.resource = s.res ?? 0; e.maxResource = s.mres ?? 100; e.resourceType = s.rtype ?? 'rage';
        if (s.cds !== undefined) e.cooldowns = new Map(Object.entries(s.cds).map(([k,v]) => [k, Number(v)]));
        e.gcdRemaining = s.gcd ?? 0; e.targetId = s.target ?? null;
        e.stats = s.stats ?? e.stats; e.weapon = s.weapon ?? e.weapon;
        e.critChance = s.crit ?? 0.05;
        this.xp = s.xp ?? 0; this.copper = s.copper ?? 0;
        if (s.inv !== undefined) { this.inventory = s.inv; this.invChanged = true; }
        if (s.buyback !== undefined) { this.vendorBuyback = s.buyback; this.invChanged = true; }
        if (s.equip !== undefined) this.equipment = s.equip;
        if (s.qlog !== undefined) this.questLog = new Map((s.qlog as any[]).map((q) => [q.questId, q]));
        if (s.qdone !== undefined) this.questsDone = new Set(s.qdone);
        if (s.qlog !== undefined || s.qdone !== undefined) this.pendingQuestCommands?.clear();
        if (s.tal !== undefined && s.tal) {
          this.talents = s.tal.alloc ?? emptyAllocation();
          this.talentSpec = s.tal.spec ?? null;
          this.talentRole = s.tal.role ?? null;
          this.loadouts = s.tal.loadouts ?? [];
          this.activeLoadout = typeof s.tal.activeLoadout === 'number' ? s.tal.activeLoadout : -1;
        }
        this.known = abilitiesKnownAt(this.cfg.playerClass, e.level, computeTalentModifiers(this.cfg.playerClass, this.talents));
        if (s.party !== undefined) this.partyInfo = s.party;
        if (s.trade !== undefined) this.tradeInfo = s.trade;
        if (s.duel !== undefined) this.duelInfo = s.duel;
      }
    }

    for (const [id] of this.entities) { if (!seen.has(id)) this.entities.delete(id); }
  };

  // consumeInputEchoSamples
  c.consumeInputEchoSamples = function(): number[] {
    const s = this.inputEchoSamples; this.inputEchoSamples = []; return s;
  };

  // consumeInventoryChanged
  c.consumeInventoryChanged = function(): boolean {
    const v = this.invChanged; this.invChanged = false; return v;
  };

  // player getter
  Object.defineProperty(c, 'player', { get() { return this.entities.get(this.playerId) ?? blankEntity(this.playerId); }, configurable: true });

  // talentPoints helper
  c.talentPoints = function() {
    const { talentPointsAtLevel } = require('../src/sim/content/talents');
    const total = talentPointsAtLevel(this.player?.level ?? 1);
    let spent = 0; for (const r of Object.values(this.talents.ranks)) spent += r as number;
    return { total, spent };
  };

  return c;
}

describe('delta snapshots', () => {
  let server: GameServer;
  let fc: FakeClient;
  let session: ClientSession;

  beforeEach(() => {
    server = new GameServer();
    fc = fakeWs();
    session = joinServer(server, fc, 1, 'Testa');
  });

  it('first snapshot carries the full self state', () => {
    broadcast(server);
    const snap = lastSnap(fc.sent);
    expect(snap).not.toBeNull();
    for (const key of DELTA_KEYS) {
      expect(snap.self, `self.${key} missing from first snapshot`).toHaveProperty(key);
    }
    expect(snap.self.party).toBeNull();
    expect(snap.self.trade).toBeNull();
    expect(Array.isArray(snap.self.inv)).toBe(true);
    expect(Array.isArray(snap.ents)).toBe(true);
  });

  it('omits unchanged heavy fields from subsequent snapshots', () => {
    broadcast(server);
    fc.sent.length = 0;
    server.sim.tick();
    broadcast(server);
    const snap = lastSnap(fc.sent);
    for (const key of DELTA_KEYS) {
      expect(snap.self, `self.${key} resent although unchanged`).not.toHaveProperty(key);
    }
    // the always-on fields are still present every snapshot
    for (const key of ['x', 'z', 'hp', 'mhp', 'res', 'gcd', 'xp', 'copper', 'target']) {
      expect(snap.self).toHaveProperty(key);
    }
  });

  it('sell command forwards bounded stack quantities', () => {
    const player = server.sim.entities.get(session.pid)!;
    const vendor = [...server.sim.entities.values()].find((e) => e.templateId === 'trader_wilkes')!;
    player.pos = { ...vendor.pos, x: vendor.pos.x + 2 };
    player.prevPos = { ...player.pos };
    server.sim.addItem('wolf_fang', 5, session.pid);

    server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'sell', item: 'wolf_fang', count: 3 }));

    expect(server.sim.meta(session.pid)?.copper).toBe(12);
    expect(server.sim.countItem('wolf_fang', session.pid)).toBe(2);

    server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'sell', item: 'wolf_fang', count: 99 }));

    expect(server.sim.meta(session.pid)?.copper).toBe(20);
    expect(server.sim.countItem('wolf_fang', session.pid)).toBe(0);
  });

  it('discard command mirrors inventory and quest progress changes', () => {
    const meta = server.sim.meta(session.pid)!;
    meta.questLog.set('q_widows', { questId: 'q_widows', counts: [10, 0], state: 'active' });
    server.sim.addItem('widow_venom_sac', 6, session.pid);
    broadcast(server);
    fc.sent.length = 0;

    server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'discard', item: 'widow_venom_sac', count: 2 }));
    broadcast(server);

    expect(server.sim.countItem('widow_venom_sac', session.pid)).toBe(4);
    expect(meta.questLog.get('q_widows')).toMatchObject({ counts: [10, 4], state: 'active' });
    const snap = lastSnap(fc.sent);
    expect(snap.self.inv).toEqual([{ itemId: 'widow_venom_sac', count: 4 }]);
    expect(snap.self.qlog).toEqual([{ questId: 'q_widows', counts: [10, 4], state: 'active' }]);
  });

  it('echoes the last processed input sequence in self snapshots', () => {
    server.handleMessage(session, JSON.stringify({ t: 'input', seq: 7, mi: { f: 1 } }));
    broadcast(server);
    const snap = lastSnap(fc.sent);
    expect(snap.self.ack).toBe(7);

    server.handleMessage(session, JSON.stringify({ t: 'input', seq: 6, mi: { f: 0 } }));
    fc.sent.length = 0;
    broadcast(server);
    expect(lastSnap(fc.sent).self.ack).toBe(7);
  });

  it('turns echoed input acks into client latency samples', () => {
    const client = bareClient(1);
    const first = { id: 1, k: 'player', tid: 'player', nm: 'Testa', lv: 1, x: 0, y: 0, z: 0, f: 0, hp: 100, mhp: 100 };
    (client as any).pendingInputSeqSentAt.set(1, 100);
    (client as any).pendingInputSeqSentAt.set(2, 140);

    const oldPerf = (globalThis as any).performance;
    (globalThis as any).performance = { now: () => 200 };
    try {
      (client as any).applySnapshot({ t: 'snap', ents: [], self: { ...first, ack: 2 } });
    } finally {
      (globalThis as any).performance = oldPerf;
    }

    expect(client.consumeInputEchoSamples()).toEqual([100, 60]);
    expect(client.consumeInputEchoSamples()).toEqual([]);
  });

  it('snaps a dead mob to its respawn pose instead of interpolating from the corpse', () => {
    const client = bareClient(1);
    const corpse = {
      id: 99, k: 'mob', tid: 'forest_wolf', nm: 'Forest Wolf', lv: 1,
      x: 0, y: 0, z: 0, f: 0, hp: 0, mhp: 45, dead: true, h: true,
    };
    const respawned = {
      id: 99, tid: 'forest_wolf', nm: 'Forest Wolf', lv: 1,
      x: 10, y: 0, z: 0, f: 0, hp: 45, mhp: 45, dead: false, h: true,
    };

    const oldPerf = (globalThis as any).performance;
    (globalThis as any).performance = { now: () => 100 };
    try {
      (client as any).applySnapshot({ t: 'snap', ents: [corpse] });
      (globalThis as any).performance = { now: () => 125 };
      (client as any).applySnapshot({ t: 'snap', ents: [respawned] });
    } finally {
      (globalThis as any).performance = oldPerf;
    }

    const mob = client.entities.get(99)!;
    expect(mob.dead).toBe(false);
    expect(mob.pos.x).toBe(10);
    expect(mob.prevPos).toEqual(mob.pos);
  });

  it('resends a heavy field once it changes', () => {
    broadcast(server);
    fc.sent.length = 0;
    server.sim.addItem('baked_bread', 2, session.pid);
    broadcast(server);
    const snap = lastSnap(fc.sent);
    expect(snap.self).toHaveProperty('inv');
    expect(snap.self.inv.some((s: any) => s.itemId === 'baked_bread')).toBe(true);
    expect(snap.self).not.toHaveProperty('qlog');
    expect(snap.self).not.toHaveProperty('stats');
  });

  it('mirrors vendor buyback deltas to the client', () => {
    const wilkes = [...server.sim.entities.values()].find((e) => e.templateId === 'trader_wilkes')!;
    const player = server.sim.entities.get(session.pid)!;
    player.pos.x = wilkes.pos.x + 2;
    player.pos.z = wilkes.pos.z;
    player.prevPos = { ...player.pos };
    server.sim.addItem('apprentice_staff', 1, session.pid);
    broadcast(server);
    const client = bareClient(session.pid);
    (client as any).applySnapshot(lastSnap(fc.sent));
    expect(client.vendorBuyback).toEqual([]);
    expect(client.consumeInventoryChanged()).toBe(true);

    fc.sent.length = 0;
    server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'sell', item: 'apprentice_staff' }));
    broadcast(server);
    const snap = lastSnap(fc.sent);
    expect(snap.self).toHaveProperty('buyback');
    expect(snap.self.buyback).toEqual([{ itemId: 'apprentice_staff', count: 1 }]);

    const buybackOnly = { ...snap, self: { ...snap.self } };
    delete buybackOnly.self.inv;
    (client as any).applySnapshot(buybackOnly);
    expect(client.vendorBuyback).toEqual([{ itemId: 'apprentice_staff', count: 1 }]);
    expect(client.consumeInventoryChanged()).toBe(true);
  });

  it('quest commands force a quest-state resync even when rejected', () => {
    broadcast(server);
    fc.sent.length = 0;
    // unknown quest: the sim rejects it and quest state does not change, but
    // the next snapshot must still carry quest fields so stale client UI
    // converges back to the server's truth
    server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'accept', quest: 'no_such_quest' }));
    broadcast(server);
    const snap = lastSnap(fc.sent);
    expect(snap.self).toHaveProperty('qlog');
    expect(snap.self).toHaveProperty('qdone');
    expect(snap.self).not.toHaveProperty('inv');
  });

  it('rejected distant quest accepts resync the authoritative quest state', () => {
    broadcast(server);
    fc.sent.length = 0;
    const player = server.sim.entities.get(session.pid)!;
    player.pos.x = 0;
    player.pos.z = -40;

    server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'accept', quest: 'q_wolves' }));
    broadcast(server);
    const snap = lastSnap(fc.sent);
    expect(snap.self.qlog).toEqual([]);
    expect(snap.self.qdone).toEqual([]);
  });

  it('each client gets full state on its own first snapshot', () => {
    broadcast(server);
    const fc2 = fakeWs();
    joinServer(server, fc2, 2, 'Testb');
    broadcast(server);
    const snapNew = lastSnap(fc2.sent);
    for (const key of DELTA_KEYS) {
      expect(snapNew.self, `self.${key} missing for fresh session`).toHaveProperty(key);
    }
    // the veteran session still gets deltas only
    const snapOld = lastSnap(fc.sent);
    expect(snapOld.self).not.toHaveProperty('inv');
    // both players spawn together, so each sees the other in ents
    expect(snapNew.ents.some((e: any) => e.id === session.pid)).toBe(true);
  });
});

describe('online movement input lifetime', () => {
  it('clears stale held movement when the websocket input stream goes quiet', () => {
    const server = new GameServer();
    const fc = fakeWs();
    const session = joinServer(server, fc, 1, 'Spinner');

    server.handleMessage(session, JSON.stringify({
      t: 'input',
      seq: 1,
      mi: { f: 0, b: 0, tl: 1, tr: 0, sl: 0, sr: 0, j: 0 },
    }));
    const meta = server.sim.meta(session.pid)!;
    expect(meta.moveInput.turnLeft).toBe(true);

    for (let i = 0; i < Math.floor(0.5 / DT); i++) server.sim.tick();
    (server as any).clearStaleInputs();
    expect(meta.moveInput.turnLeft).toBe(true);

    for (let i = 0; i < Math.ceil(0.35 / DT); i++) server.sim.tick();
    (server as any).clearStaleInputs();
    expect(meta.moveInput.turnLeft).toBe(false);
  });
});

describe('chat moderation', () => {
  it('rate-limits chat bursts per connected client before cooldown', () => {
    const server = new GameServer();
    const fc = fakeWs();
    const session = joinServer(server, fc, 1, 'Testa');
    fc.sent.length = 0;

    for (let i = 0; i < 6; i++) {
      server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'chat', text: `msg ${i}` }));
    }
    (server as any).routeEvents(server.sim.tick());

    const events = fc.sent.flatMap((msg) => msg.t === 'events' ? msg.list : []);
    expect(events.filter((ev) => ev.type === 'chat')).toHaveLength(5);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      text: 'You are sending messages too quickly. Slow down.',
    }));
  });

  it('locks chat for 20 seconds after repeated over-limit messages', () => {
    const server = new GameServer();
    const fc = fakeWs();
    const session = joinServer(server, fc, 1, 'Testa');
    fc.sent.length = 0;

    for (let i = 0; i < 8; i++) {
      server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'chat', text: `msg ${i}` }));
    }
    (server as any).routeEvents(server.sim.tick());

    const events = fc.sent.flatMap((msg) => msg.t === 'events' ? msg.list : []);
    expect(events.filter((ev) => ev.type === 'chat')).toHaveLength(5);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      text: 'Chat locked for 20s because you are sending messages too quickly.',
    }));
  });

  it('blocks hard-word (slur) messages and escalates warning -> mute', () => {
    const server = new GameServer();
    server.chatFilter.load({ soft: [], hard: ['slurword'], config: { warningsBeforeMute: 1, muteLadderSeconds: [600] } });
    const fc = fakeWs();
    const session = joinServer(server, fc, 1, 'Testa');

    // First offense: blocked entirely + warning; it never becomes a chat event.
    fc.sent.length = 0;
    server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'chat', text: 'you are a slurword' }));
    (server as any).routeEvents(server.sim.tick());
    let events = fc.sent.flatMap((msg) => msg.t === 'events' ? msg.list : []);
    expect(events.some((ev) => ev.type === 'chat')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', text: expect.stringContaining('Warning') }));

    // Second offense: escalates to a timed mute.
    fc.sent.length = 0;
    server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'chat', text: 'slurword strikes again' }));
    events = fc.sent.flatMap((msg) => msg.t === 'events' ? msg.list : []);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', text: expect.stringContaining('muted') }));

    // Now muted: even a clean message is dropped until the mute expires.
    fc.sent.length = 0;
    server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'chat', text: 'hello everyone' }));
    (server as any).routeEvents(server.sim.tick());
    events = fc.sent.flatMap((msg) => msg.t === 'events' ? msg.list : []);
    expect(events.some((ev) => ev.type === 'chat')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', text: expect.stringContaining('muted') }));
  });

  it('leaves soft (cosmetic) words untouched server-side — clients mask them', () => {
    const server = new GameServer();
    server.chatFilter.load({ soft: ['darn'], hard: [], config: { warningsBeforeMute: 1, muteLadderSeconds: [600] } });
    const fc = fakeWs();
    const session = joinServer(server, fc, 1, 'Testa');
    fc.sent.length = 0;
    server.handleMessage(session, JSON.stringify({ t: 'cmd', cmd: 'chat', text: 'oh darn it' }));
    (server as any).routeEvents(server.sim.tick());
    const events = fc.sent.flatMap((msg) => msg.t === 'events' ? msg.list : []);
    expect(events).toContainEqual(expect.objectContaining({ type: 'chat', text: 'oh darn it' }));
  });

  it('ships the soft word list to clients in the hello payload', () => {
    const server = new GameServer();
    server.chatFilter.load({ soft: ['darn', 'heck'], hard: ['slurword'], config: { warningsBeforeMute: 1, muteLadderSeconds: [600] } });
    const fc = fakeWs();
    joinServer(server, fc, 1, 'Testa');
    const hello = fc.sent.find((msg) => msg.t === 'hello');
    expect(hello.softWords).toEqual(['darn', 'heck']);
    // Hard words are enforcement-only and must never be shipped to the client.
    expect(JSON.stringify(hello)).not.toContain('slurword');
  });

});

describe('autosaves', () => {
  beforeEach(() => {
    vi.mocked(saveCharacterState).mockReset();
    vi.mocked(saveCharacterState).mockResolvedValue(undefined);
  });

  it('skips overlapping saveAll runs while saving each current session once', async () => {
    const server = new GameServer();
    joinServer(server, fakeWs(), 1, 'Testa');
    joinServer(server, fakeWs(), 2, 'Testb');
    joinServer(server, fakeWs(), 3, 'Testc');

    let resolveFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      resolveFirstSave = resolve;
    });
    vi.mocked(saveCharacterState).mockImplementationOnce(() => firstSave);

    const firstRun = server.saveAll('test');
    await vi.waitFor(() => {
      expect(saveCharacterState).toHaveBeenCalledTimes(3);
    });

    await server.saveAll('test');
    expect(saveCharacterState).toHaveBeenCalledTimes(3);

    resolveFirstSave();
    await firstRun;

    const savedCharacterIds = vi.mocked(saveCharacterState).mock.calls.map((call) => call[0]);
    expect(savedCharacterIds.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('waits for an active autosave before running the shutdown save pass', async () => {
    const server = new GameServer();
    joinServer(server, fakeWs(), 1, 'Testa');
    joinServer(server, fakeWs(), 2, 'Testb');

    let resolveFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      resolveFirstSave = resolve;
    });
    vi.mocked(saveCharacterState).mockImplementationOnce(() => firstSave);

    const autosave = server.saveAll('autosave');
    await vi.waitFor(() => {
      expect(saveCharacterState).toHaveBeenCalledTimes(2);
    });

    const shutdown = server.saveAll('shutdown');
    await Promise.resolve();
    expect(saveCharacterState).toHaveBeenCalledTimes(2);

    resolveFirstSave();
    await autosave;
    await shutdown;

    const savedCharacterIds = vi.mocked(saveCharacterState).mock.calls.map((call) => call[0]);
    expect(savedCharacterIds.sort((a, b) => a - b)).toEqual([1, 1, 2, 2]);
  });
});

describe('/who command', () => {
  it('lists online players with class, level, realm, and zone metadata', () => {
    const server = new GameServer();
    const fc = fakeWs();
    const self = joinServer(server, fc, 1, 'Aleph', 'warrior');
    const fc2 = fakeWs();
    const other = joinServer(server, fc2, 2, 'Bet', 'mage');
    server.sim.setPlayerLevel(7, other.pid);
    fc.sent.length = 0;

    server.handleMessage(self, JSON.stringify({ t: 'cmd', cmd: 'chat', text: '/who' }));

    const text = eventTexts(fc.sent).join('\n');
    expect(text).toContain('Who: 2 players online on Claudemoon.');
    expect(text).toContain('Aleph - level 1 warrior - Eastbrook Vale');
    expect(text).toContain('Bet - level 7 mage - Eastbrook Vale');
  });

  it('hides ignored players and players who ignored the requester', () => {
    const server = new GameServer();
    const fc = fakeWs();
    const self = joinServer(server, fc, 1, 'Aleph');
    const fcIgnored = fakeWs();
    const ignored = joinServer(server, fcIgnored, 2, 'Bet');
    const fcBlocking = fakeWs();
    const blocking = joinServer(server, fcBlocking, 3, 'Gimel');
    self.blockedIds = new Set([ignored.characterId]);
    blocking.blockedIds = new Set([self.characterId]);
    fc.sent.length = 0;

    server.handleMessage(self, JSON.stringify({ t: 'cmd', cmd: 'chat', text: '/who' }));

    const text = eventTexts(fc.sent).join('\n');
    expect(text).toContain('Who: 1 player online on Claudemoon.');
    expect(text).toContain('Aleph - level 1 warrior - Eastbrook Vale');
    expect(text).not.toContain('Bet');
    expect(text).not.toContain('Gimel');
  });

  it('waits for the requester ignore list before showing online players', () => {
    const server = new GameServer();
    const fc = fakeWs();
    const self = joinServer(server, fc, 1, 'Aleph');
    joinServer(server, fakeWs(), 2, 'Bet');
    self.blockListLoaded = false;
    fc.sent.length = 0;

    server.handleMessage(self, JSON.stringify({ t: 'cmd', cmd: 'chat', text: '/who' }));

    expect(eventTexts(fc.sent)).toContain('Your ignore list is still loading. Try /who again in a moment.');
  });

  it('omits players whose own ignore list is still loading', () => {
    const server = new GameServer();
    const fc = fakeWs();
    const self = joinServer(server, fc, 1, 'Aleph');
    const pending = joinServer(server, fakeWs(), 2, 'Bet');
    pending.blockListLoaded = false;
    fc.sent.length = 0;

    server.handleMessage(self, JSON.stringify({ t: 'cmd', cmd: 'chat', text: '/who' }));

    const text = eventTexts(fc.sent).join('\n');
    expect(text).toContain('Who: 1 player online on Claudemoon.');
    expect(text).toContain('Aleph - level 1 warrior - Eastbrook Vale');
    expect(text).not.toContain('Bet');
  });
});

describe('client-side delta merge', () => {
  it('does not apply optimistic quest accept or completion state', () => {
    const client = bareClient(1);
    // In the Supabase architecture, acceptQuest/turnInQuest are no-ops on ClientWorld
    // (they just call the sim directly). Quest state is managed locally.
    // Verify the quest log is not modified by the no-op calls.
    client.acceptQuest('q_wolves');
    expect(client.questLog.has('q_wolves')).toBe(false);

    // Set up a quest in the log manually, then verify turnInQuest doesn't modify it
    client.questLog.set('q_wolves', { questId: 'q_wolves', counts: [8], state: 'ready' });
    client.turnInQuest('q_wolves');
    // turnInQuest is also a no-op, so the quest stays in the log
    expect(client.questLog.has('q_wolves')).toBe(true);
  });

  it('flushes changed movement immediately without resending unchanged frames', () => {
    const client = bareClient(1);
    const sent: any[] = [];
    (client as any).ws = { readyState: 1, send: (payload: string) => sent.push(JSON.parse(payload)) };
    const oldWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = { OPEN: 1 };
    try {
      Object.assign(client.moveInput, { forward: true, back: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, jump: false });
      expect(client.flushInput(100)).toBe(true);
      expect(sent).toEqual([{ t: 'input', seq: 1, mi: { f: 1, b: 0, tl: 0, tr: 0, sl: 0, sr: 0, j: 0 } }]);

      expect(client.flushInput(105)).toBe(false);
      expect(sent).toHaveLength(1);

      Object.assign(client.moveInput, { forward: false, strafeRight: true });
      expect(client.flushInput(115)).toBe(false);
      expect(sent).toHaveLength(1);

      expect(client.flushInput(120)).toBe(true);
      expect(sent.at(-1)).toEqual({ t: 'input', seq: 2, mi: { f: 0, b: 0, tl: 0, tr: 0, sl: 0, sr: 1, j: 0 } });
    } finally {
      (globalThis as any).WebSocket = oldWebSocket;
    }
  });

  it('keeps previous structures when delta fields are omitted', () => {
    const server = new GameServer();
    const fc = fakeWs();
    const session = joinServer(server, fc, 1, 'Testa');
    const client = bareClient(session.pid);

    server.sim.addItem('conjured_water', 1, session.pid);
    broadcast(server);
    (client as any).applySnapshot(lastSnap(fc.sent));
    expect(client.inventory.length).toBeGreaterThan(0);
    const invRef = client.inventory;
    const qlogRef = client.questLog;
    const qdoneRef = client.questsDone;
    const cdsRef = client.player.cooldowns;

    fc.sent.length = 0;
    server.sim.tick();
    broadcast(server);
    (client as any).applySnapshot(lastSnap(fc.sent));
    // omitted fields neither reset nor get rebuilt
    expect(client.inventory).toBe(invRef);
    expect(client.questLog).toBe(qlogRef);
    expect(client.questsDone).toBe(qdoneRef);
    expect(client.player.cooldowns).toBe(cdsRef);

    fc.sent.length = 0;
    server.sim.addItem('baked_bread', 1, session.pid);
    broadcast(server);
    (client as any).applySnapshot(lastSnap(fc.sent));
    expect(client.inventory).not.toBe(invRef);
    expect(client.inventory.some((s) => s.itemId === 'baked_bread')).toBe(true);
  });
});
