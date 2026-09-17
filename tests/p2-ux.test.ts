/**
 * tests/p2-ux.test.ts — the six P2 UX findings from UX-FINDINGS-APP.md.
 *
 * These lock the presentation contracts the fixes established, each while the
 * response STATUS and the tenancy boundary stay exactly as before:
 *
 *   - an authenticated visitor's error/404 page keeps their account controls,
 *     and a page that cannot name a member drops the account area rather than
 *     claim a signed-out "Sign in";
 *   - marketing links leave the app in a new tab with a hardened rel and a cue
 *     that says so;
 *   - audit detail is a readable phrase with the raw record one disclosure away;
 *   - the empty Audit log points at the outstanding setup step;
 *   - a saved channel selection names the next step, and the no-channel state
 *     offers a reload.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

process.env.SEROS_SESSION_SECRET = 'test-session-secret-for-p2-ux-1234567';
process.env.SEROS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.SEROS_SLACK = 'fake';

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { csrfToken, type Session } from '../src/auth';
import { page, auditDetail, extLink } from '../src/views';
import { auditPage } from '../src/routes/queue';
import { channelsPage } from '../src/routes/connect';

const WS = 'ws-p2';

function response() {
  let statusCode = 200;
  let body = '';
  let redirectTo = '';
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    type(_t: string) { return res; },
    send(value: unknown) { body = String(value); return res; },
    redirect(code: number, location: string) { statusCode = code; redirectTo = location; return res; },
    setHeader() { return res; },
  };
  return { res, get status() { return statusCode; }, get body() { return body; }, get redirect() { return redirectTo; } };
}

async function fresh(label: string) {
  const path = join(mkdtempSync(join(tmpdir(), `seros-p2-${label}-`)), 'test.db');
  await migrateDbAsync(path);
  process.env.SEROS_DB = path;
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, WS);
  await scope.addMember('u-owner', 'Ola Owner', 'owner');
  return { db, scope, path };
}

const sessionFor = (memberId: string): Session =>
  ({ workspaceId: WS, memberId, issuedAt: Date.now(), sid: `sid-${memberId}`, pv: 0 });

// ---------------------------------------------------------------------------
// P2 — error/404 chrome reflects the real account, never a false "Sign in"
// ---------------------------------------------------------------------------

test('an error page for a resolved member keeps their account controls', () => {
  const html = page('Something went wrong', '', '<h1>Something went wrong</h1>',
    { member: { id: 'u-owner', name: 'Ola Owner', role: 'owner' }, csrf: 'tok' });
  assert.match(html, /class="who"/);
  assert.ok(html.includes('Ola Owner'));
  assert.match(html, /action="\/logout"[\s\S]*Sign out/);
  assert.ok(!html.includes('<a href="/login" class="linkish">Sign in</a>'),
    'a signed-in visitor is never told to sign in on an error page');
});

test('an error page for an unresolved account shows neither an account nor a misleading sign-in', () => {
  const html = page('Something went wrong', '', '<h1>Something went wrong</h1>', { suppressAccount: true });
  assert.ok(!html.includes('<a href="/login" class="linkish">Sign in</a>'),
    'an outage must not read as a sign-out');
  assert.ok(!html.includes('class="who"'), 'no account controls are invented for an unknown member');
});

test('a signed-out visitor still sees the sign-in affordance', () => {
  const html = page('Not found', '', '<h1>Not here</h1>', {});
  assert.match(html, /<a href="\/login" class="linkish">Sign in<\/a>/);
});

// ---------------------------------------------------------------------------
// P2 — marketing links leave the app in a new tab, with a cue
// ---------------------------------------------------------------------------

test('external links open in a new tab, are rel-hardened, and announce themselves', () => {
  const html = extLink('https://seros.dev/pricing', 'Pricing');
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener"/);
  assert.match(html, /\(opens in a new tab\)/);
});

test('the footer marketing links are external-tab links', () => {
  const html = page('Queue', '/queue', '<h1>Q</h1>', {});
  const foot = html.slice(html.indexOf('app-foot'));
  assert.match(foot, /href="https:\/\/seros\.dev\/"[^>]*target="_blank"[^>]*rel="noopener"/);
  assert.ok(!/<a href="https:\/\/seros\.dev\/">Website<\/a>/.test(foot),
    'the old same-tab link is gone');
});

// ---------------------------------------------------------------------------
// P2 — audit detail is a readable phrase, not raw JSON
// ---------------------------------------------------------------------------

test('audit detail renders key/value phrases with a disclosure for the raw record', () => {
  const html = auditDetail(JSON.stringify({ member_id: 'u-owner', reason: 'bad_password' }));
  assert.match(html, /member id/);
  assert.match(html, /u-owner/);
  assert.match(html, /<details[^>]*>[\s\S]*Technical detail/);
  assert.ok(!/^\{/.test(html.trim()), 'the cell does not lead with a raw brace');
});

test('audit detail escapes values and never emits an unparsed object as markup', () => {
  const html = auditDetail(JSON.stringify({ note: '<img src=x onerror=alert(1)>' }));
  assert.ok(!html.includes('onerror=alert(1)>'), 'a stored value cannot become markup');
});

test('audit detail with a non-JSON string falls back to escaped text', () => {
  assert.equal(auditDetail(null), '');
  assert.match(auditDetail('plain text'), /plain text/);
});

// ---------------------------------------------------------------------------
// P2 — the empty Audit log points at the outstanding setup step
// ---------------------------------------------------------------------------

test('the empty audit log of an unconnected workspace points to Slack setup', async () => {
  await fresh('audit-empty');
  const out = response();
  await auditPage({ serosSession: sessionFor('u-owner'), query: {}, body: {} } as any, out.res);
  assert.equal(out.status, 200);
  assert.match(out.body, /No activity recorded yet/);
  assert.match(out.body, /href="\/connect"/, 'the next action is to connect Slack');
});

// ---------------------------------------------------------------------------
// P2 — channels: a reload action, and a next step after saving
// ---------------------------------------------------------------------------

test('the no-channel state offers a reload as well as a way back', async () => {
  const { scope } = await fresh('channels-empty');
  await scope.saveConnection({
    teamId: 'T1', teamName: 'Acme', botUserId: 'B1',
    tokenEnc: 'enc', scopes: 'channels:read', installedBy: 'u-owner',
  });
  const out = response();
  await channelsPage({ serosSession: sessionFor('u-owner'), query: {}, body: {} } as any, out.res);
  assert.equal(out.status, 200);
  assert.match(out.body, /No channels are visible yet/);
  assert.match(out.body, /Reload channels/, 'a reload action is offered');
});

test('a saved channel selection names Review drafts as the next step', async () => {
  const { scope } = await fresh('channels-saved');
  await scope.saveConnection({
    teamId: 'T1', teamName: 'Acme', botUserId: 'B1',
    tokenEnc: 'enc', scopes: 'channels:read', installedBy: 'u-owner',
  });
  await scope.recordChannels([{ id: 'C-one', name: 'one', isPrivate: false }]);
  const out = response();
  await channelsPage({ serosSession: sessionFor('u-owner'), query: { msg: 'saved' }, body: {} } as any, out.res);
  assert.equal(out.status, 200);
  assert.match(out.body, /class="notice good"/, 'the save is confirmed');
  assert.match(out.body, /Review drafts/, 'the next step is named');
  assert.match(out.body, /href="\/queue"/);
});

void csrfToken;
