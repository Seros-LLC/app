/** OAuth state regression tests: Slack linking must survive another serverless instance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_SESSION_SECRET = 'test-session-secret-slack-oauth-123456';

import { createOAuthState, consumeOAuthState, databaseOAuthStateStore, type OAuthStateStore } from '../src/slack/oauth-state';
import { migrateDbAsync, openDb } from '../src/db/client';

function store(): OAuthStateStore {
  const rows = new Map<string, { value: string; expiresAt: number }>();
  return {
    async put(key, value, expiresAt) { rows.set(key, { value, expiresAt }); },
    async take(key) {
      const row = rows.get(key);
      rows.delete(key);
      return row;
    },
  };
}

test('Slack OAuth state is single-use and binds the authenticated workspace member', async () => {
  const key = crypto.randomBytes(32).toString('hex');
  const s = await createOAuthState(store(), { workspaceId: 'ws-a', memberId: 'member-a' });
  assert.ok(s.state.length >= 32);
  assert.equal(await consumeOAuthState(store(), key), undefined);
  const shared = store();
  const anotherInstance: OAuthStateStore = shared;
  const created = await createOAuthState(shared, { workspaceId: 'ws-a', memberId: 'member-a' });
  assert.deepEqual(await consumeOAuthState(anotherInstance, created.state), { workspaceId: 'ws-a', memberId: 'member-a' });
  assert.equal(await consumeOAuthState(shared, created.state), undefined);
});

test('database-backed Slack OAuth state is consumable once across handles', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-oauth-state-')), 'test.db');
  await migrateDbAsync(path);
  const first = databaseOAuthStateStore(openDb(path));
  const second = databaseOAuthStateStore(openDb(path));
  const created = await createOAuthState(first, { workspaceId: 'ws-db', memberId: 'member-db' });
  const results = await Promise.all([
    consumeOAuthState(first, created.state),
    consumeOAuthState(second, created.state),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(results.find(Boolean), { workspaceId: 'ws-db', memberId: 'member-db' });
  assert.equal(await consumeOAuthState(first, created.state), undefined);
});
