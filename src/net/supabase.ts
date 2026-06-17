// Supabase REST API client — replaces the custom backend for auth, characters,
// leaderboard, friends, ignore, and chat. No @supabase client library required;
// uses the raw Supabase REST API directly so no Node.js polyfills are needed.
//
// Architecture notes:
//  - Supabase Anon Key is used for all requests (bearer token).
//  - Password hashing is done on the client via Web Crypto API (PBKDF2).
//  - RLS policies in Supabase must allow:
//      • INSERT on accounts (for registration, anon)
//      • SELECT/INSERT on characters (for CRUD, filtered by account_id)
//      • SELECT on ladder (public leaderboard)
//      • SELECT/INSERT on friends/ignores (filtered by account_id)
//      • SELECT/INSERT on chat_logs (public reads, account-scoped writes)
//      • SELECT on accounts (login lookup)
//  - Supabase Realtime (websocket-based) is used for live chat when available.
//  - For other real-time features (combat, entity sync), we fall back to
//    polling or offline simulation (no WebSocket backend needed).

import type { PlayerClass } from '../sim/types';
import type {
  CharacterSearchResult, FriendInfo, LeaderboardEntry, SocialInfo,
} from '../world_api';

// ---------------------------------------------------------------------------
// Constants & configuration
// ---------------------------------------------------------------------------

// Injected at build time by vite.config.ts
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

const SUPABASE_URL = __SUPABASE_URL__ || 'https://vagekvcsjacfvoidvzzj.supabase.co';
const SUPABASE_ANON_KEY = __SUPABASE_ANON_KEY__ || '';

// Session stored in sessionStorage
const SESSION_KEY = 'wocc_supabase_session';

export interface Session {
  accountId: string; // Supabase auth.users UUID
  username: string;
}

// ---------------------------------------------------------------------------
// Password hashing (Web Crypto API — runs entirely in browser)
// ---------------------------------------------------------------------------

// PBKDF2: 100_000 iterations, SHA-256, 32-byte output → base64url
async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const saltBytes = enc.encode(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial, 256,
  );
  return btoa(String.fromCharCode(...Array.from(new Uint8Array(bits))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function hashPasswordForAccount(password: string): Promise<string> {
  // Generate a random salt per account (stored alongside hash in DB as "salt:hash")
  const salt = btoa(String.fromCharCode(...Array.from(crypto.getRandomValues(new Uint8Array(16)))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const hash = await hashPassword(password, salt);
  return salt + ':' + hash;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const idx = stored.indexOf(':');
  if (idx < 0) return false;
  const salt = stored.slice(0, idx);
  const expectedHash = stored.slice(idx + 1);
  const computed = await hashPassword(password, salt);
  return computed === expectedHash;
}

// ---------------------------------------------------------------------------
// Low-level REST helpers
// ---------------------------------------------------------------------------

function supabaseHeaders(includeAuth = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  };
  if (includeAuth) {
    const session = getSession();
    if (session) {
      headers['Authorization'] = `Bearer ${SUPABASE_ANON_KEY}`;
    }
  }
  return headers;
}

export async function sbGet<T = any>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      headers: supabaseHeaders(),
    });
    if (!res.ok) return null;
    return res.json() as T;
  } catch {
    return null;
  }
}

async function sbPost<T = any>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      method: 'POST',
      headers: supabaseHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => []);
      const msg = Array.isArray(err) ? err[0]?.message : (err?.message ?? `HTTP ${res.status}`);
      throw new Error(msg);
    }
    return res.json() as T;
  } catch {
    return null;
  }
}

async function sbPatch(path: string, body: unknown, accountId?: string): Promise<boolean> {
  try {
    const headers = supabaseHeaders();
    if (accountId) {
      // Use Pre-Heroku RLS workaround: send account_id in body for RLS to match
      headers[' Prefer'] = 'return=representation';
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sbDelete(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      method: 'DELETE',
      headers: supabaseHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export function getSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setSession(session: Session | null): void {
  if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(SESSION_KEY);
}

export function getAccountId(): string | null {
  return getSession()?.accountId ?? null;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Register a new account. Returns the account ID on success. */
export async function sbRegister(username: string, password: string): Promise<string> {
  const passwordHash = await hashPasswordForAccount(password);
  const result = await sbPost<{ id: string }[]>(
    '/rest/v1/accounts?select=id',
    {
      username: username.trim().toLowerCase(),
      password_hash: passwordHash,
      created_at: new Date().toISOString(),
    },
  );
  if (!result || result.length === 0) throw new Error('Registration failed');
  return result[0].id;
}

/** Login: looks up account by username and verifies password hash.
 *  Returns account ID on success. */
export async function sbLogin(username: string, password: string): Promise<Session> {
  const accounts = await sbGet<{ id: string; username: string; password_hash: string }[]>(
    `/rest/v1/accounts?username=eq.${encodeURIComponent(username.trim().toLowerCase())}&select=id,username,password_hash&limit=1`,
  );
  if (!accounts || accounts.length === 0) throw new Error('Account not found');
  const account = accounts[0];
  const valid = await verifyPassword(password, account.password_hash);
  if (!valid) throw new Error('Invalid password');
  const session: Session = { accountId: account.id, username: account.username };
  setSession(session);
  return session;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export interface SbCharacterSummary {
  id: string;
  account_id: string;
  name: string;
  class: PlayerClass;
  level: number;
  xp: number;
  realm: string;
  created_at: string;
  skin?: number;
  force_rename?: boolean;
  game_state?: string | GameState; // JSONB — may be string (raw JSON) or object (parsed)
}

function mapCharacter(c: SbCharacterSummary) {
  return {
    id: c.id, // Supabase UUID string
    name: c.name,
    class: c.class as PlayerClass,
    level: c.level ?? 1,
    skin: c.skin ?? 0,
    online: false,
    forceRename: c.force_rename ?? false,
  };
}

/** List all characters for the current account. */
export async function sbListCharacters(): Promise<ReturnType<typeof mapCharacter>[]> {
  const session = getSession();
  if (!session) return [];
  const chars = await sbGet<SbCharacterSummary[]>(
    `/rest/v1/characters?account_id=eq.${session.accountId}&order=created_at.desc`,
  );
  return (chars ?? []).map(mapCharacter);
}

/** Create a new character. */
export async function sbCreateCharacter(name: string, cls: PlayerClass, skin = 0): Promise<void> {
  const session = getSession();
  if (!session) throw new Error('Not logged in');
  await sbPost('/rest/v1/characters', {
    account_id: session.accountId,
    name,
    class: cls,
    level: 1,
    xp: 0,
    realm: 'Claudemoon',
    skin,
    created_at: new Date().toISOString(),
    // game_state stores inventory, equipment, copper, quest log etc. as JSONB
    game_state: JSON.stringify({
      inventory: [],
      equipment: {},
      copper: 0,
      questLog: {},
      questsDone: [],
      talents: null,
      talentSpec: null,
      talentRole: null,
      loadouts: [],
      activeLoadout: -1,
    }),
  });
}

/** Delete a character. */
export async function sbDeleteCharacter(characterId: string, name: string): Promise<void> {
  const session = getSession();
  if (!session) throw new Error('Not logged in');
  const ok = await sbDelete(
    `/rest/v1/characters?id=eq.${characterId}&account_id=eq.${session.accountId}`,
  );
  if (!ok) throw new Error('Delete failed');
}

// ---------------------------------------------------------------------------
// Game state (stored as JSONB in the characters table)
// ---------------------------------------------------------------------------

export interface GameState {
  inventory: any[];
  equipment: Record<string, string>;
  copper: number;
  questLog: Record<string, any>;
  questsDone: string[];
  talents: any;
  talentSpec: string | null;
  talentRole: any;
  loadouts: any[];
  activeLoadout: number;
}

/** Save the player's game state to their character row. */
export async function sbSaveGameState(characterId: string, state: Partial<GameState>): Promise<void> {
  const session = getSession();
  if (!session) return;
  // Read current game_state, merge, write back
  const chars = await sbGet<SbCharacterSummary[]>(
    `/rest/v1/characters?id=eq.${characterId}&account_id=eq.${session.accountId}&select=game_state`,
  );
  const existing: GameState = chars?.[0]?.game_state
    ? (typeof chars[0].game_state === 'string' ? JSON.parse(chars[0].game_state) : chars[0].game_state)
    : { inventory: [], equipment: {}, copper: 0, questLog: {}, questsDone: [], talents: null, talentSpec: null, talentRole: null, loadouts: [], activeLoadout: -1 };
  const merged: GameState = { ...existing, ...state };
  await sbPatch(
    `/rest/v1/characters?id=eq.${characterId}&account_id=eq.${session.accountId}`,
    { game_state: JSON.stringify(merged) },
    session.accountId,
  );
}

/** Load the player's game state from their character row. */
export async function sbLoadGameState(characterId: string): Promise<GameState> {
  const session = getSession();
  if (!session) return { inventory: [], equipment: {}, copper: 0, questLog: {}, questsDone: [], talents: null, talentSpec: null, talentRole: null, loadouts: [], activeLoadout: -1 };
  const chars = await sbGet<SbCharacterSummary[]>(
    `/rest/v1/characters?id=eq.${characterId}&account_id=eq.${session.accountId}&select=game_state`,
  );
  const raw = chars?.[0]?.game_state;
  if (!raw) return { inventory: [], equipment: {}, copper: 0, questLog: {}, questsDone: [], talents: null, talentSpec: null, talentRole: null, loadouts: [], activeLoadout: -1 };
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ---------------------------------------------------------------------------
// Leaderboard (ladder table)
// ---------------------------------------------------------------------------

export interface LadderEntry {
  id: string;
  account_id: string;
  character_id: string;
  rating: number;
  wins: number;
  losses: number;
  realm: string;
  updated_at: string;
  characters?: { name: string; class: PlayerClass; level: number }[];
}

export interface ArenaLadderEntry {
  pid: number;
  name: string;
  cls: PlayerClass;
  rating: number;
  wins: number;
  losses: number;
}

export async function sbGetLeaderboard(realm = 'Claudemoon'): Promise<ArenaLadderEntry[]> {
  const rows = await sbGet<LadderEntry[]>(
    `/rest/v1/ladder?realm=eq.${realm}&order=rating.desc&select=*,characters:characters(name,class,level)&limit=100`,
  );
  if (!rows) return [];
  return rows.map((r, i) => {
    const char = r.characters?.[0];
    return {
      pid: parseInt(r.character_id.replace(/-/g, '').slice(0, 8), 16) || i,
      name: char?.name ?? 'Unknown',
      cls: (char?.class ?? 'warrior') as PlayerClass,
      rating: r.rating ?? 1000,
      wins: r.wins ?? 0,
      losses: r.losses ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Friends & Ignore
// ---------------------------------------------------------------------------

export interface FriendRow {
  id: string;
  account_id: string;
  friend_id: string;
  created_at: string;
  friend_account?: { username: string };
  friend_char?: { name: string; class: string; level: number }[];
}

export interface IgnoreRow {
  id: string;
  account_id: string;
  ignored_id: string;
  created_at: string;
  ignored_account?: { username: string };
}

/** Get friends list for current account. */
export async function sbGetFriends(): Promise<FriendInfo[]> {
  const session = getSession();
  if (!session) return [];
  const rows = await sbGet<FriendRow[]>(
    `/rest/v1/friends?account_id=eq.${session.accountId}&select=*,friend_account:accounts!friend_id(username),friend_char:characters(account_id,friend_id,name,class,level)`,
  );
  if (!rows) return [];
  return rows.map(r => ({
    id: parseInt(r.friend_id.replace(/-/g, '').slice(0, 8), 16) || 0,
    name: r.friend_account?.username ?? 'Unknown',
    cls: r.friend_char?.[0]?.class ?? 'warrior',
    level: r.friend_char?.[0]?.level ?? 1,
    realm: 'Claudemoon',
    online: false,
  }));
}

/** Get blocked users list. */
export async function sbGetIgnores(): Promise<{ id: number; name: string }[]> {
  const session = getSession();
  if (!session) return [];
  const rows = await sbGet<IgnoreRow[]>(
    `/rest/v1/ignores?account_id=eq.${session.accountId}&select=*,ignored_account:accounts!ignored_id(username)`,
  );
  if (!rows) return [];
  return rows.map(r => ({
    id: parseInt(r.ignored_id.replace(/-/g, '').slice(0, 8), 16) || 0,
    name: r.ignored_account?.username ?? 'Unknown',
  }));
}

/** Add a friend by username. */
export async function sbFriendAdd(name: string): Promise<void> {
  const session = getSession();
  if (!session) return;
  // Look up the account by username
  const targets = await sbGet<{ id: string }[]>(
    `/rest/v1/accounts?username=eq.${encodeURIComponent(name.toLowerCase())}&select=id&limit=1`,
  );
  if (!targets || targets.length === 0) throw new Error('User not found');
  const friendId = targets[0].id;
  if (friendId === session.accountId) throw new Error('Cannot add self');
  await sbPost('/rest/v1/friends', {
    account_id: session.accountId,
    friend_id: friendId,
    created_at: new Date().toISOString(),
  });
}

/** Remove a friend. */
export async function sbFriendRemove(name: string): Promise<void> {
  const session = getSession();
  if (!session) return;
  const targets = await sbGet<{ id: string }[]>(
    `/rest/v1/accounts?username=eq.${encodeURIComponent(name.toLowerCase())}&select=id&limit=1`,
  );
  if (!targets || targets.length === 0) return;
  await sbDelete(`/rest/v1/friends?account_id=eq.${session.accountId}&friend_id=eq.${targets[0].id}`);
}

/** Block a user by username. */
export async function sbBlockAdd(name: string): Promise<void> {
  const session = getSession();
  if (!session) return;
  const targets = await sbGet<{ id: string }[]>(
    `/rest/v1/accounts?username=eq.${encodeURIComponent(name.toLowerCase())}&select=id&limit=1`,
  );
  if (!targets || targets.length === 0) throw new Error('User not found');
  await sbPost('/rest/v1/ignores', {
    account_id: session.accountId,
    ignored_id: targets[0].id,
    created_at: new Date().toISOString(),
  });
}

/** Unblock a user. */
export async function sbBlockRemove(name: string): Promise<void> {
  const session = getSession();
  if (!session) return;
  const targets = await sbGet<{ id: string }[]>(
    `/rest/v1/accounts?username=eq.${encodeURIComponent(name.toLowerCase())}&select=id&limit=1`,
  );
  if (!targets || targets.length === 0) return;
  await sbDelete(`/rest/v1/ignores?account_id=eq.${session.accountId}&ignored_id=eq.${targets[0].id}`);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  realm: string;
  sender_id: string;
  sender_name: string;
  message: string;
  channel: string;
  created_at: string;
}

/** Fetch recent chat messages for a channel. */
export async function sbGetChat(channel = 'General', limit = 50): Promise<ChatMessage[]> {
  const rows = await sbGet<ChatMessage[]>(
    `/rest/v1/chat_logs?channel=eq.${channel}&order=created_at.desc&limit=${limit}`,
  );
  return (rows ?? []).reverse(); // oldest first
}

/** Send a chat message. */
export async function sbSendChat(message: string, channel = 'General'): Promise<void> {
  const session = getSession();
  if (!session) return;
  await sbPost('/rest/v1/chat_logs', {
    realm: 'Claudemoon',
    sender_id: session.accountId,
    sender_name: session.username,
    message,
    channel,
    created_at: new Date().toISOString(),
  });
}

/** Search characters by name (for friend/ignore autocomplete). */
export async function sbSearchCharacters(query: string): Promise<CharacterSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await sbGet<{ name: string; class: PlayerClass; level: number }[]>(
    `/rest/v1/characters?name=ilike.*${encodeURIComponent(q)}*&select=name,class,level&limit=10`,
  );
  return (rows ?? []).map(r => ({
    name: r.name,
    cls: r.class ?? 'warrior',
    level: r.level ?? 1,
  }));
}
