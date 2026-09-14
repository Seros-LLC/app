import crypto from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { oauthStates } from '../db/schema';
import { affectedRows } from '../db/client';
import type { Db } from '../db/client';

export interface OAuthStateValue {
  workspaceId: string;
  memberId: string;
}

export interface OAuthStateStore {
  put(key: string, value: string, expiresAt: number): Promise<void>;
  take(key: string): Promise<string | { value: string; expiresAt: number } | undefined>;
}

const TTL_MS = 10 * 60 * 1000;

export function hashState(state: string): string {
  return crypto.createHash('sha256').update(state).digest('hex');
}

export function databaseOAuthStateStore(db: Db): OAuthStateStore {
  return {
    async put(key, value, expiresAt) {
      const now = Date.now();
      await db.insert(oauthStates).values({
        stateHash: hashState(key), value, expiresAt, createdAt: now,
      });
      await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
    },
    async take(key) {
      const stateHash = hashState(key);
      const now = Date.now();
      const row = (await db.select().from(oauthStates)
        .where(and(eq(oauthStates.stateHash, stateHash), gt(oauthStates.expiresAt, now)))
        .limit(1))[0];
      if (!row) return undefined;
      const removed = await db.run(sql`DELETE FROM oauth_states
        WHERE state_hash = ${stateHash} AND expires_at > ${now}`);
      return affectedRows(removed) === 1 ? row.value : undefined;
    },
  };
}

export async function createOAuthState(
  store: OAuthStateStore,
  value: OAuthStateValue,
  now = Date.now(),
): Promise<{ state: string; expiresAt: number }> {
  const state = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + TTL_MS;
  await store.put(state, JSON.stringify(value), expiresAt);
  return { state, expiresAt };
}

export async function consumeOAuthState(
  store: OAuthStateStore,
  state: string,
  now = Date.now(),
): Promise<OAuthStateValue | undefined> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) return undefined;
  const row = await store.take(state);
  if (!row) return undefined;
  const raw = typeof row === 'string' ? row : row.expiresAt > now ? row.value : undefined;
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<OAuthStateValue>;
    if (typeof value.workspaceId !== 'string' || !value.workspaceId ||
        typeof value.memberId !== 'string' || !value.memberId) return undefined;
    return { workspaceId: value.workspaceId, memberId: value.memberId };
  } catch {
    return undefined;
  }
}
