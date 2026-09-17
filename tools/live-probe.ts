/**
 * Turns "a deployed function answered" into a checkable statement about the
 * secrets Vercel refuses to show us.
 *
 * `api/index.ts` calls `validateServerlessEnvironment()` at module scope, so the
 * function cannot answer a single request unless every rule in the boot contract
 * passed against the REAL values. `await boot()` then runs the migration before
 * the handler, so a 200 also proves DATABASE_URL actually connects — not merely
 * that it looks like a Postgres URL. `?deep=1` additionally asks the provider
 * whether our credential is still accepted.
 *
 * A live 200 plus `provider.state=ok` is the explicit deployment-level evidence
 * this checker uses to close the hidden-secret gap for all seven values returned by
 * Vercel as `[SENSITIVE]`. The probe never claims to know or print any value.
 * `SEROS_RESET_SECRET` is included because the boot contract validates it before
 * the handler can answer.
 *
 * Nothing here prints a response body. Secret material could be anywhere in one;
 * only a status code, a known-enum provider state, and a sanitised deployment id
 * ever reach stdout.
 */

/** Keys a live 200 proves, and the rule each one is proven against. */
export const PROVEN_BY_LIVE_BOOT: Readonly<Record<string, string>> = Object.freeze({
  SEROS_SESSION_SECRET: '>= 16 chars — requireSecret() ran against the real value at module scope',
  SEROS_SIGNING_SECRET: '>= 16 chars — requireSecret() ran against the real value at module scope',
  CRON_SECRET: '>= 16 chars — requireSecret() ran against the real value at module scope',
  SEROS_ENCRYPTION_KEY: '>= 16 chars — requireSecret() ran against the real value at module scope',
  SEROS_RESET_SECRET: '>= 16 chars — requireSecret() ran against the real value at module scope',
  DATABASE_URL: 'isPgUrl() passed, and the pre-handler migration connected to it',
  SEROS_PROVIDER_API_KEY: 'present at boot, and ?deep=1 reports the provider accepted it',
});

/** Reserved for future hidden keys that are intentionally outside the boot contract. */
export const NOT_PROVEN_BY_LIVE_BOOT: Readonly<Record<string, string>> = Object.freeze({});

const CREDENTIAL_STATES = ['ok', 'invalid', 'unreachable', 'unconfigured'] as const;
export type KnownProviderState = (typeof CREDENTIAL_STATES)[number] | 'unrecognised' | 'absent';

export interface ProbeOutcome {
  /** True only for: HTTP 200 AND provider.state === 'ok'. */
  readonly proven: boolean;
  readonly url: string;
  readonly status: number | null;
  readonly providerState: KnownProviderState | null;
  readonly deploymentId: string | null;
  /** Present when `proven` is false: what stopped the probe from proving anything. */
  readonly reason: string | null;
}

export interface ProbeOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Parse argv without a dependency. The env-file path is the first non-flag
 * argument, so `--live-probe` may appear on either side of it. Lives here rather
 * than in the CLI so both flag forms can be tested without spawning a process.
 */
export function parseCliArgs(argv: readonly string[]): { envFile: string; liveProbeUrl: string | null } {
  let envFile: string | null = null;
  let liveProbeUrl: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--live-probe') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--live-probe requires a URL, e.g. --live-probe https://app.seros.dev');
      }
      liveProbeUrl = next;
      i++;
    } else if (arg.startsWith('--live-probe=')) {
      liveProbeUrl = arg.slice('--live-probe='.length);
      if (!liveProbeUrl) throw new Error('--live-probe requires a URL');
    } else if (!arg.startsWith('--') && envFile === null) {
      envFile = arg;
    }
  }
  return { envFile: envFile ?? '/tmp/seros-prod.env', liveProbeUrl };
}

/**
 * Deployment ids come from response headers, which are platform- or
 * attacker-shaped strings. Scrubbing bad characters is not enough: stripping the
 * punctuation out of `iad1::abc\nSEROS_SIGNING_SECRET=leaked` yields a single
 * token that still contains the payload. Reject anything that is not already a
 * plain id instead, and print nothing rather than something shaped wrong.
 */
function sanitiseDeploymentId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /^[A-Za-z0-9:._-]{1,120}$/.test(raw) ? raw : null;
}

/** Accept only the enum the app can emit; never echo an arbitrary string. */
function readProviderState(body: unknown): KnownProviderState {
  if (body === null || typeof body !== 'object') return 'absent';
  const provider = (body as { provider?: unknown }).provider;
  if (provider === null || typeof provider !== 'object') return 'absent';
  const state = (provider as { state?: unknown }).state;
  if (typeof state !== 'string') return 'absent';
  return (CREDENTIAL_STATES as readonly string[]).includes(state)
    ? (state as KnownProviderState)
    : 'unrecognised';
}

/**
 * Build the health URL from an operator-supplied base. Refuses anything that is
 * not a plain https origin: a probe pointed at http:// could have its answer
 * rewritten by anyone on the path, and "the deployment booted" would then be a
 * claim made by the network rather than by the deployment.
 */
export function healthUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('--live-probe needs an absolute URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('--live-probe must use https: an unauthenticated answer proves nothing');
  }
  if (url.username || url.password) {
    throw new Error('--live-probe URL must not carry credentials');
  }
  const base = url.origin + url.pathname.replace(/\/$/, '');
  // Query parameters on the operator's base could smuggle credentials or alter
  // the health request; the probe owns the query string completely.
  return `${base}/health?deep=1`;
}

/**
 * GET <url>/health?deep=1 and reduce the answer to the three facts we are allowed
 * to print. Any failure is a failure to prove — never a silent pass.
 */
export async function probeLiveBoot(baseUrl: string, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const url = healthUrl(baseUrl);
  const timeoutMs = opts.timeoutMs ?? Number(process.env.SEROS_PROBE_TIMEOUT_MS || 15_000);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await doFetch(url, { method: 'GET', signal: ctl.signal, redirect: 'error' });
  } catch (e: any) {
    // Do not echo network/library errors: proxies and TLS stacks can include URLs,
    // headers, or other request material. Keep only the stable failure class.
    const why = e?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : 'request failed';
    return {
      proven: false, url, status: null, providerState: null, deploymentId: null,
      reason: `the deployment did not answer (${why})`,
    };
  } finally {
    clearTimeout(timer);
  }

  const deploymentId = sanitiseDeploymentId(
    res.headers?.get?.('x-vercel-id') ?? res.headers?.get?.('x-vercel-deployment-url') ?? null,
  );

  if (res.status !== 200) {
    return {
      proven: false, url, status: res.status, providerState: null, deploymentId,
      reason: `expected HTTP 200, got ${res.status}: the function did not complete a healthy boot`,
    };
  }

  let providerState: KnownProviderState;
  try {
    providerState = readProviderState(await res.json());
  } catch {
    return {
      proven: false, url, status: res.status, providerState: null, deploymentId,
      reason: 'the response was not JSON, so provider credential state could not be read',
    };
  }

  if (providerState !== 'ok') {
    return {
      proven: false, url, status: res.status, providerState, deploymentId,
      reason: `provider.state=${providerState}: SEROS_PROVIDER_API_KEY is not proven usable`,
    };
  }

  return { proven: true, url, status: res.status, providerState, deploymentId, reason: null };
}

export interface LiveClassification {
  /** Hidden keys the probe upgraded to "verified by live boot". */
  readonly verified: readonly string[];
  /** Hidden keys still needing a human, with the reason each is unproven. */
  readonly stillUnproven: readonly { key: string; why: string }[];
}

/**
 * Split the hidden keys into what the probe earned and what it did not. Called
 * with a failed probe, nothing is verified and every key carries the failure
 * reason — a failed probe must never look like a partial pass.
 */
export function classifyHiddenKeys(hiddenKeys: readonly string[], probe: ProbeOutcome): LiveClassification {
  if (!probe.proven) {
    const why = probe.reason ?? 'the live probe did not prove a healthy boot';
    return { verified: [], stillUnproven: hiddenKeys.map((key) => ({ key, why })) };
  }
  const verified: string[] = [];
  const stillUnproven: { key: string; why: string }[] = [];
  for (const key of hiddenKeys) {
    if (key in PROVEN_BY_LIVE_BOOT) verified.push(key);
    else stillUnproven.push({ key, why: NOT_PROVEN_BY_LIVE_BOOT[key] ?? 'not covered by the boot contract' });
  }
  return { verified, stillUnproven };
}

/**
 * Render the probe section. Every line here is derived from a status code, a
 * fixed enum, a sanitised header, or a constant in this file — no response body
 * and no environment value can reach the output.
 */
export function renderLiveProbe(probe: ProbeOutcome, classification: LiveClassification): string[] {
  const where = probe.deploymentId ? `deployment ${probe.deploymentId}` : 'deployment id not reported';
  const lines: string[] = ['', `Live boot probe: ${probe.url}`];

  if (probe.proven) {
    lines.push(`  answered HTTP ${probe.status}, provider.state=${probe.providerState} (${where})`);
    lines.push('', 'Verified by live boot (the deployed function ran the contract against the real values):');
    for (const key of classification.verified) lines.push(`  - ${key}: ${PROVEN_BY_LIVE_BOOT[key]}`);
  } else {
    const seen = probe.status === null ? 'no response' : `HTTP ${probe.status}`;
    lines.push(`  FAILED — ${seen}${probe.providerState ? `, provider.state=${probe.providerState}` : ''} (${where})`);
    lines.push(`  ${probe.reason}`);
    lines.push('', 'Unproven guarantees (the probe could not stand in for a human check):');
  }

  if (classification.stillUnproven.length > 0) {
    if (probe.proven) lines.push('', 'Still NOT proven by a live boot:');
    for (const { key, why } of classification.stillUnproven) lines.push(`  - ${key}: ${why}`);
  }
  return lines;
}
