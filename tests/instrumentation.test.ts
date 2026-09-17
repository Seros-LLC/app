import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope, MILESTONE_EVENTS } from '../src/db/scope';
import { auditEvents, tasks } from '../src/db/schema';

async function fixture(id: string) {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-instrumentation-')), 'test.db');
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, id);
  await scope.addMember('member-1', 'Member', 'confirmer');
  return { db, scope };
}

function detail(row: { detail: string | null }): Record<string, unknown> {
  assert.ok(row.detail);
  return JSON.parse(row.detail!);
}

test('milestone instrumentation emits the complete event vocabulary with dimensions', async () => {
  const { scope } = await fixture('ws-instrumentation');

  for (const event of MILESTONE_EVENTS) await scope.instrument(event, 'web');

  const rows = await scope.auditRows(100);
  const byEvent = new Map(rows.map((row) => [row.event, row]));
  assert.deepEqual([...byEvent.keys()].sort(), [...MILESTONE_EVENTS].sort());
  for (const event of MILESTONE_EVENTS) {
    const row = byEvent.get(event);
    assert.ok(row, `missing ${event}`);
    assert.equal(row!.workspaceId, 'ws-instrumentation');
    assert.equal(row!.outcome, 'ok');
    assert.deepEqual(detail(row!), { tier: 'trial', source: 'web' });
  }
});

test('suggestion_shown is first-view idempotent and confirmation aliases are emitted', async () => {
  const { scope } = await fixture('ws-suggestion-events');
  const message = await scope.ingestMessage({
    channelId: 'C1', ts: '1.1', authorId: 'member-1', body: 'I will send the report tomorrow',
  });
  const draftId = await scope.createDraft({
    sourceMessageId: message.row.id, title: 'Send the report', outcome: 'Report sent',
    kind: 'commitment', confidence: 90, suggestedOwner: 'member-1', suggestedDueDate: null, provider: 'fake',
  });

  assert.equal((await scope.pendingDraftsForQueue()).length, 1);
  assert.equal((await scope.pendingDraftsForQueue()).length, 1);
  const shown = (await scope.auditRows(100)).filter((row) => row.event === 'suggestion_shown');
  assert.equal(shown.length, 1);
  assert.deepEqual(detail(shown[0]!), { draft_id: draftId, tier: 'trial', source: 'web' });

  const confirmed = await scope.confirm(draftId, 'confirmed', 'member-1');
  assert.equal(confirmed.ok, true);
  const confirmation = (await scope.auditRows(100)).find((row) => row.event === 'suggestion_confirmed');
  assert.ok(confirmation);
  assert.equal(detail(confirmation!).source, 'web');
  assert.equal(detail(confirmation!).tier, 'trial');
});

test('trial conversion records the new billing tier and source', async () => {
  const { scope } = await fixture('ws-trial-conversion');
  await scope.setBillingTier('team', 'operator');
  await scope.setBillingTier('scale', 'operator');

  const rows = (await scope.auditRows(100)).filter((row) => row.event === 'trial_converted');
  assert.equal(rows.length, 1);
  assert.deepEqual(detail(rows[0]!), { from_tier: 'trial', to_tier: 'team', tier: 'team', source: 'operator' });
  assert.equal(await scope.billingTier(), 'scale');
});

test('tracker_connected records only the first successful tracker write', async () => {
  const { db, scope } = await fixture('ws-tracker-event');
  const first = await scope.ingestMessage({
    channelId: 'C1', ts: '1.1', authorId: 'member-1', body: 'I will send the first report',
  });
  const second = await scope.ingestMessage({
    channelId: 'C1', ts: '1.2', authorId: 'member-1', body: 'I will send the second report',
  });
  const firstDraft = await scope.createDraft({
    sourceMessageId: first.row.id, title: 'First', outcome: 'Done', kind: 'commitment',
    confidence: 90, suggestedOwner: 'member-1', suggestedDueDate: null, provider: 'fake',
  });
  const secondDraft = await scope.createDraft({
    sourceMessageId: second.row.id, title: 'Second', outcome: 'Done', kind: 'commitment',
    confidence: 90, suggestedOwner: 'member-1', suggestedDueDate: null, provider: 'fake',
  });
  const firstConfirmation = await scope.confirm(firstDraft, 'confirmed', 'member-1');
  const secondConfirmation = await scope.confirm(secondDraft, 'confirmed', 'member-1');
  assert.equal(firstConfirmation.ok, true);
  assert.equal(secondConfirmation.ok, true);

  const firstTask = (await db.select().from(tasks).where(eq(tasks.workspaceId, 'ws-tracker-event')))[0]!;
  const secondTask = (await db.select().from(tasks).where(eq(tasks.workspaceId, 'ws-tracker-event')))[1]!;
  const firstClaim = await scope.claimTaskWrite(firstTask.id);
  const secondClaim = await scope.claimTaskWrite(secondTask.id);
  assert.equal(firstClaim.state, 'claimed');
  assert.equal(secondClaim.state, 'claimed');
  if (firstClaim.state !== 'claimed' || secondClaim.state !== 'claimed') throw new Error('expected claims');

  assert.equal(await scope.completeTaskWrite(firstTask.id, firstClaim.token, {
    tracker: 'linear', externalId: 'LIN-1', externalUrl: 'https://linear.invalid/LIN-1',
  }), true);
  assert.equal(await scope.completeTaskWrite(secondTask.id, secondClaim.token, {
    tracker: 'linear', externalId: 'LIN-2', externalUrl: 'https://linear.invalid/LIN-2',
  }), true);

  const connected = (await scope.auditRows(100)).filter((row) => row.event === 'tracker_connected');
  assert.equal(connected.length, 1);
  assert.equal(detail(connected[0]!).source, 'system');
  assert.equal(detail(connected[0]!).tier, 'trial');
});
