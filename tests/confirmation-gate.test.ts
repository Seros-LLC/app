/**
 * tests/confirmation-gate.test.ts — task creation requires a real confirmation.
 *
 * IMPLEMENTATION-BRIEF invariant 1 and ADR 0002 make this the central safety
 * boundary: a task may be created only from a human Confirmation. Existing
 * confirmation tests exercise edits and normal flow, but did not attempt the
 * forbidden direct task insert. This test checks both sides of the gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { tasks } from '../src/db/schema';

async function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-confirm-gate-')), 'test.db');
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, 'ws-confirm-gate');
  await scope.addMember('member-1', 'Member', 'confirmer');
  const message = await scope.ingestMessage({
    channelId: 'C1', ts: '1.1', authorId: 'member-1', body: 'I will finish the review tomorrow',
  });
  const draftId = await scope.createDraft({
    sourceMessageId: message.row.id, title: 'Finish review', outcome: 'Review complete',
    kind: 'commitment', confidence: 90, suggestedOwner: 'member-1', suggestedDueDate: null, provider: 'fake',
  });
  return { db, scope, draftId };
}

test('a direct task insert with no confirmation is rejected by the database gate', async () => {
  const { db } = await fixture();
  await assert.rejects(
    () => db.insert(tasks).values({
      workspaceId: 'ws-confirm-gate', id: 'orphan-task', confirmationId: 'missing-confirmation',
      writeState: 'queued', threadReplyState: 'pending', idempotencyKey: 'orphan-key', createdAt: Date.now(),
    }),
    /foreign key|constraint|no such table/i,
    'a task without a real Confirmation is a schema violation, not an application convention',
  );
});

test('the only valid task path creates a confirmation and linked task together', async () => {
  const { db, scope, draftId } = await fixture();
  const result = await scope.confirm(draftId, 'confirmed', 'member-1');

  assert.equal(result.ok, true);
  assert.ok(result.confirmationId);
  assert.ok(result.taskId);
  const rows = await db.select().from(tasks).where(eq(tasks.workspaceId, 'ws-confirm-gate'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.confirmationId, result.confirmationId);
  assert.equal(rows[0]!.id, result.taskId);
});

test('a rejected confirmation creates no task at all', async () => {
  // The task gate is not only "a confirmation must exist" but "the human said
  // yes": a `rejected` decision records the Confirmation and must never emit a
  // Task. Without this, a future refactor of confirm() could leak a queued task
  // out of a rejection.
  const { db, scope, draftId } = await fixture();
  const result = await scope.confirm(draftId, 'rejected', 'member-1');

  assert.equal(result.ok, true);
  assert.equal(result.taskId, null, 'a rejection produces no task id');
  const rows = await db.select().from(tasks).where(eq(tasks.workspaceId, 'ws-confirm-gate'));
  assert.equal(rows.length, 0, 'a rejected draft leaves the tasks table empty');
});

test('confirming the same draft twice yields one task, not two', async () => {
  // The confirm→task edge must be exactly 1:1. A double-click (or a retried
  // request) replays the first confirmation rather than minting a second task;
  // the uniqueIndex on (workspace_id, confirmation_id) is the last line of
  // defense, but the replay branch is what a caller actually hits.
  const { db, scope, draftId } = await fixture();
  const first = await scope.confirm(draftId, 'confirmed', 'member-1');
  const second = await scope.confirm(draftId, 'confirmed', 'member-1');

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.confirmationId, first.confirmationId, 'the same confirmation is replayed');
  assert.equal(second.taskId, first.taskId, 'the same task is returned, not a new one');
  const rows = await db.select().from(tasks).where(eq(tasks.workspaceId, 'ws-confirm-gate'));
  assert.equal(rows.length, 1, 'exactly one task exists for the confirmation');
});

test('a task cannot borrow a confirmation from another workspace', async () => {
  // The FK is composite — (workspace_id, confirmation_id) REFERENCES
  // confirmations(workspace_id, id) — so a confirmation that is real in tenant A
  // is not a valid parent for a task in tenant B, even though its id exists in
  // the confirmations table. This is the point where the task gate and tenancy
  // isolation are the same boundary. Both workspaces exist first, so the only
  // constraint that can fire is the cross-tenant confirmation reference.
  const { db, scope, draftId } = await fixture();
  const confirmed = await scope.confirm(draftId, 'confirmed', 'member-1');
  assert.equal(confirmed.ok, true);

  const other = await WorkspaceScope.ensure(db, 'ws-confirm-gate-other');
  await other.addMember('member-2', 'Member Two', 'confirmer');

  await assert.rejects(
    () => db.insert(tasks).values({
      workspaceId: 'ws-confirm-gate-other', id: 'cross-tenant-task',
      confirmationId: confirmed.confirmationId!,
      writeState: 'queued', threadReplyState: 'pending',
      idempotencyKey: 'cross-tenant-key', createdAt: Date.now(),
    }),
    /foreign key|constraint/i,
    'a confirmation id from another tenant is not a valid task parent',
  );
  const stolen = await db.select().from(tasks).where(eq(tasks.workspaceId, 'ws-confirm-gate-other'));
  assert.equal(stolen.length, 0, 'no task crossed the tenant boundary');
});
