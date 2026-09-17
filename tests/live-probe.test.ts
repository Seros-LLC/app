/**
 * `npm run check:prod-env` can read every non-secret value out of a pulled Vercel
 * env file, but Vercel returns `[SENSITIVE]` for the seven secret ones, so the
 * checker could only say "a human must look at these". `--live-probe` replaces
 * that human with evidence: api/index.ts runs validateServerlessEnvironment() at
 * module scope, so a deployed function that answers 200 has already run the
 * contract against the real values.
 *
 * The risk in that trade is a probe that is too generous — one that treats a 500,
 * a rejected provider key, or an unreachable host as "probably fine" and hands a
 * green pipeline to a broken production. Every test here pins a way the probe
 * must refuse to prove something.
 *
 * No network: fetch is stubbed everywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  probeLiveBoot,
  classifyHiddenKeys,
  renderLiveProbe,
  healthUrl,
  parseCliArgs,
  PROVEN_BY_LIVE_BOOT,
  NOT_PROVEN_BY_LIVE_BOOT,
} from '../tools/live-probe';

/** The seven keys Vercel hides, exactly as check-prod-env collects them. */
const HIDDEN_KEYS = [
  'CRON_SECRET',
  'DATABASE_URL',
  'SEROS_ENCRYPTION_KEY',
  'SEROS_PROVIDER_API_KEY',
  'SEROS_RESET_SECRET',
  'SEROS_SESSION_SECRET',
  'SEROS_SIGNING_SECRET',
];

function stubFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: any) => {
    calls.push(String(url));
    return {
      status,
      headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const HEALTHY = { ok: true, ts: 1, provider: { state: 'ok', detail: 'credential accepted' } };

test('a healthy live boot proves the hidden keys the contract actually checks', async () => {
  const { impl, calls } = stubFetch(200, HEALTHY, { 'x-vercel-id': 'iad1::abc123' });
  const probe = await probeLiveBoot('https://app.seros.dev', { fetchImpl: impl });

  assert.equal(probe.proven, true);
  assert.equal(probe.status, 200);
  assert.equal(probe.providerState, 'ok');
  assert.equal(probe.deploymentId, 'iad1::abc123');
  assert.deepEqual(calls, ['https://app.seros.dev/health?deep=1']);

  const { verified, stillUnproven } = classifyHiddenKeys(HIDDEN_KEYS, probe);
  assert.deepEqual(verified.slice().sort(), [
    'CRON_SECRET',
    'DATABASE_URL',
    'SEROS_ENCRYPTION_KEY',
    'SEROS_PROVIDER_API_KEY',
    'SEROS_RESET_SECRET',
    'SEROS_SESSION_SECRET',
    'SEROS_SIGNING_SECRET',
  ]);
  assert.deepEqual(stillUnproven, []);
});

test('a 500 proves nothing and fails the check', async () => {
  const { impl } = stubFetch(500, { error: 'boom' });
  const probe = await probeLiveBoot('https://app.seros.dev', { fetchImpl: impl });

  assert.equal(probe.proven, false);
  assert.equal(probe.status, 500);
  assert.match(probe.reason!, /expected HTTP 200/);

  const { verified, stillUnproven } = classifyHiddenKeys(HIDDEN_KEYS, probe);
  // A failed probe must not look like a partial pass.
  assert.deepEqual(verified, []);
  assert.equal(stillUnproven.length, HIDDEN_KEYS.length);
});

test('provider.state=invalid fails even on a 200', async () => {
  // The deployment booted, so most secrets are fine — but the provider key is
  // refused, and reporting SEROS_PROVIDER_API_KEY as verified would be a lie.
  const { impl } = stubFetch(200, { ok: false, provider: { state: 'invalid', detail: 'rejected' } });
  const probe = await probeLiveBoot('https://app.seros.dev', { fetchImpl: impl });

  assert.equal(probe.proven, false);
  assert.equal(probe.providerState, 'invalid');
  assert.match(probe.reason!, /SEROS_PROVIDER_API_KEY is not proven usable/);
  assert.deepEqual(classifyHiddenKeys(HIDDEN_KEYS, probe).verified, []);
});

test('503 from the deep health check fails', async () => {
  const { impl } = stubFetch(503, { ok: false, provider: { state: 'invalid', detail: 'rejected' } });
  const probe = await probeLiveBoot('https://app.seros.dev', { fetchImpl: impl });
  assert.equal(probe.proven, false);
  assert.equal(probe.status, 503);
});

test('unreachable or unconfigured provider states are not proof', async () => {
  for (const state of ['unreachable', 'unconfigured']) {
    const { impl } = stubFetch(200, { ok: true, provider: { state, detail: 'x' } });
    const probe = await probeLiveBoot('https://app.seros.dev', { fetchImpl: impl });
    assert.equal(probe.proven, false, `${state} must not count as proof`);
    assert.equal(probe.providerState, state);
  }
});

test('a missing or unknown provider state is not proof', async () => {
  const { impl: noProvider } = stubFetch(200, { ok: true, ts: 1 });
  const bare = await probeLiveBoot('https://app.seros.dev', { fetchImpl: noProvider });
  assert.equal(bare.proven, false);
  assert.equal(bare.providerState, 'absent');

  // A state string we do not recognise is collapsed to a fixed token rather than
  // echoed, so a compromised or future deployment cannot inject output.
  const { impl: weird } = stubFetch(200, { provider: { state: 'ok\n  SECRET=hunter2' } });
  const odd = await probeLiveBoot('https://app.seros.dev', { fetchImpl: weird });
  assert.equal(odd.proven, false);
  assert.equal(odd.providerState, 'unrecognised');
});

test('a network failure fails the check instead of falling back to "ask a human"', async () => {
  const impl = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch;
  const probe = await probeLiveBoot('https://app.seros.dev', { fetchImpl: impl });
  assert.equal(probe.proven, false);
  assert.equal(probe.status, null);
  assert.match(probe.reason!, /did not answer/);
  assert.ok(!probe.reason!.includes('ENOTFOUND'));
});

test('a non-JSON body is a failure, not a pass', async () => {
  const impl = (async () => ({
    status: 200,
    headers: { get: () => null },
    json: async () => { throw new Error('Unexpected token < in JSON'); },
  })) as unknown as typeof fetch;
  const probe = await probeLiveBoot('https://app.seros.dev', { fetchImpl: impl });
  assert.equal(probe.proven, false);
  assert.match(probe.reason!, /not JSON/);
});

test('the probe refuses a URL that cannot authenticate the answer', () => {
  // Over plain http, "the deployment booted" is a claim made by the network.
  assert.throws(() => healthUrl('http://app.seros.dev'), /https/);
  assert.throws(() => healthUrl('app.seros.dev'), /absolute URL/);
  assert.throws(() => healthUrl('https://user:pw@app.seros.dev'), /credentials/);
  assert.equal(healthUrl('https://app.seros.dev/'), 'https://app.seros.dev/health?deep=1');
  assert.equal(healthUrl('https://app.seros.dev/base/'), 'https://app.seros.dev/base/health?deep=1');
  assert.equal(healthUrl('https://app.seros.dev/?token=should-not-forward'), 'https://app.seros.dev/health?deep=1');
});

test('no output line can carry secret material', async () => {
  // Everything a hostile or misconfigured deployment could put in a response,
  // in the places the probe reads from.
  const { impl } = stubFetch(
    200,
    { ok: true, provider: { state: 'ok', detail: 'DATABASE_URL=postgres://u:p@h/db' },
      secrets: { SEROS_SESSION_SECRET: 'super-secret-value' } },
    { 'x-vercel-id': 'iad1::abc\nSEROS_SIGNING_SECRET=leaked' },
  );
  const probe = await probeLiveBoot('https://app.seros.dev', { fetchImpl: impl });
  const out = renderLiveProbe(probe, classifyHiddenKeys(HIDDEN_KEYS, probe)).join('\n');

  for (const leak of ['super-secret-value', 'postgres://u:p@h/db', 'leaked', 'hunter2']) {
    assert.ok(!out.includes(leak), `probe output leaked ${leak}:\n${out}`);
  }
  // The detail field is never rendered at all; only the enum state is.
  assert.ok(!out.includes('detail'));
  assert.match(out, /HTTP 200/);
  assert.match(out, /provider\.state=ok/);
});

test('a failing probe names the unproven guarantee rather than the keys it liked', async () => {
  const { impl } = stubFetch(200, { provider: { state: 'invalid', detail: 'x' } }, { 'x-vercel-id': 'iad1::z' });
  const probe = await probeLiveBoot('https://app.seros.dev', { fetchImpl: impl });
  const out = renderLiveProbe(probe, classifyHiddenKeys(HIDDEN_KEYS, probe)).join('\n');

  assert.match(out, /FAILED/);
  assert.match(out, /Unproven guarantees/);
  assert.ok(!out.includes('Verified by live boot'), 'a failed probe must not print a verified section');
  for (const key of HIDDEN_KEYS) assert.ok(out.includes(key), `${key} should be listed as unproven`);
});

test('every key the probe claims is one the boot contract actually enforces', () => {
  // Guards the reverse drift: if someone adds a key to PROVEN_BY_LIVE_BOOT that
  // validateServerlessEnvironment() does not check, the probe starts vouching
  // for something no live boot exercises.
  const contract = readFileSync(join(__dirname, '..', 'src', 'deployment.ts'), 'utf8');
  for (const key of Object.keys(PROVEN_BY_LIVE_BOOT)) {
    if (key === 'DATABASE_URL') continue; // checked via isPgUrl(env.DATABASE_URL)
    assert.ok(contract.includes(key), `${key} is claimed as live-verified but absent from src/deployment.ts`);
  }
  // And the excluded key must stay excluded while it is still boot-invisible.
  assert.ok(contract.includes('SEROS_RESET_SECRET'));
  assert.ok(!('SEROS_RESET_SECRET' in NOT_PROVEN_BY_LIVE_BOOT));
  assert.ok('SEROS_RESET_SECRET' in PROVEN_BY_LIVE_BOOT);
});

test('the flag is optional and parses in either position', () => {
  assert.deepEqual(parseCliArgs(['/tmp/p.env']), { envFile: '/tmp/p.env', liveProbeUrl: null });
  assert.deepEqual(parseCliArgs(['/tmp/p.env', '--live-probe', 'https://app.seros.dev']),
    { envFile: '/tmp/p.env', liveProbeUrl: 'https://app.seros.dev' });
  assert.deepEqual(parseCliArgs(['--live-probe', 'https://app.seros.dev', '/tmp/p.env']),
    { envFile: '/tmp/p.env', liveProbeUrl: 'https://app.seros.dev' });
  assert.deepEqual(parseCliArgs(['/tmp/p.env', '--live-probe=https://app.seros.dev']),
    { envFile: '/tmp/p.env', liveProbeUrl: 'https://app.seros.dev' });
  assert.throws(() => parseCliArgs(['/tmp/p.env', '--live-probe']), /requires a URL/);
});
