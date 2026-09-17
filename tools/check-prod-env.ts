/**
 * Runs the REAL production boot contract (src/deployment.ts) against the REAL
 * production environment pulled from Vercel, and reports every reason it would
 * refuse to boot — not just the first one.
 *
 * Secret VALUES cannot be pulled from Vercel, so they arrive as the literal
 * placeholder "[SENSITIVE]". Those are reported separately as "cannot verify
 * locally" rather than being counted as passes or failures: this script proves
 * what IS broken, and is honest about what it cannot see.
 *
 * `--live-probe <https-url>` closes most of that gap without a human. The
 * deployed function runs this same contract at module scope, so a healthy answer
 * is evidence about the values we cannot read. See tools/live-probe.ts for what
 * that does and does not prove.
 *
 *   npm run check:prod-env -- /tmp/seros-prod.env --live-probe https://app.seros.dev
 */
import { readFileSync } from 'node:fs';
import { validateServerlessEnvironment } from '../src/deployment';
import { probeLiveBoot, classifyHiddenKeys, renderLiveProbe, parseCliArgs } from './live-probe';

const PLACEHOLDER = '[SENSITIVE]';

let parsed: { envFile: string; liveProbeUrl: string | null };
try {
  parsed = parseCliArgs(process.argv.slice(2));
} catch (e: any) {
  console.error(String(e?.message ?? e));
  process.exit(2);
}
const ENV_FILE = parsed.envFile;
const LIVE_PROBE_URL = parsed.liveProbeUrl;

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)="?(.*?)"?$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const real = parseEnvFile(ENV_FILE);
const secretsWeCannotSee = Object.entries(real)
  .filter(([, v]) => v === PLACEHOLDER)
  .map(([k]) => k);

// Vercel sets this at runtime; the pulled file describes the same deployment.
const env: NodeJS.ProcessEnv = { ...real, VERCEL: '1' };

// Substitute plausible values ONLY for secrets whose value is hidden, so that a
// length/format rule about a secret cannot masquerade as a provider misconfig.
const assumed: string[] = [];
for (const key of secretsWeCannotSee) {
  assumed.push(key);
  env[key] = key === 'DATABASE_URL'
    ? 'postgresql://assumed:assumed@db.example.com:5432/seros'
    : 'assumed-secret-value-not-verifiable-locally';
}

console.log(`Boot contract: src/deployment.ts against production env (${ENV_FILE})\n`);

/** Every failure, not just the first: re-run, removing each cause as it is found. */
const failures: string[] = [];
for (let i = 0; i < 12; i++) {
  try {
    validateServerlessEnvironment(env);
    break;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (failures.includes(msg)) break;
    failures.push(msg);
    // Neutralise this cause so the next call reveals the next one.
    if (msg.includes('SEROS_SLACK must be http')) {
      env.SEROS_SLACK = 'http';
    } else if (msg.includes('SEROS_TRACKER=fake')) {
      delete env.SEROS_TRACKER;
    } else if (msg.includes('SEROS_TRACKER must be empty or linear')) {
      env.SEROS_TRACKER = 'linear';
    } else if (msg.includes('SEROS_WORKSPACE must not be a demo')) {
      delete env.SEROS_WORKSPACE;
    } else if (msg.includes('SEROS_WORKSPACE must be a real')) {
      delete env.SEROS_WORKSPACE;
    } else if (msg.includes('SEROS_ENCRYPTION_KEY')) {
      env.SEROS_ENCRYPTION_KEY = 'assumed-encryption-key';
    } else if (msg.includes('LINEAR_API_KEY')) {
      env.LINEAR_API_KEY = 'assumed-linear-api-key';
    } else if (msg.includes('LINEAR_TEAM_ID')) {
      env.LINEAR_TEAM_ID = 'assumed-linear-team-id';
    } else if (msg.includes('SLACK_CLIENT_ID')) {
      env.SLACK_CLIENT_ID = 'assumed-slack-client-id';
    } else if (msg.includes('SLACK_CLIENT_SECRET')) {
      env.SLACK_CLIENT_SECRET = 'assumed-slack-client-secret';
    } else if (msg.includes('SEROS_PROVIDER_CHAIN must not contain `fake`') || msg.includes('must include `http`')) {
      env.SEROS_PROVIDER_CHAIN = 'http';
    } else if (msg.includes('SEROS_PROVIDER=fake')) {
      delete env.SEROS_PROVIDER;
    } else if (msg.includes('SEROS_PROVIDER_API_KEY')) {
      env.SEROS_PROVIDER_API_KEY = 'assumed-api-key';
    } else if (msg.includes('SEROS_PROVIDER_ALLOWED_HOSTS')) {
      env.SEROS_PROVIDER_ALLOWED_HOSTS = new URL(env.SEROS_PROVIDER_BASE_URL!).hostname;
    } else if (msg.includes('SEROS_PROVIDER_BASE_URL')) {
      env.SEROS_PROVIDER_BASE_URL = 'https://assumed.example.com';
    } else if (msg.includes('DATABASE_URL')) {
      env.DATABASE_URL = 'postgresql://assumed:assumed@db.example.com:5432/seros';
    } else {
      break; // unrecognised: stop rather than guess
    }
  }
}

if (failures.length === 0) {
  console.log('PASS — nothing in the visible configuration blocks boot.');
} else {
  console.log(`BLOCKED — ${failures.length} reason(s) the deployment would refuse to boot:\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  // A blocked production environment must fail CI/pre-deploy callers. The report
  // remains human-readable, but a zero exit status would turn it into a warning.
  process.exitCode = 1;
}

/** Today's conservative report, unchanged, for runs without --live-probe. */
function reportUnverified(): void {
  console.log('\nNot verifiable locally (Vercel hides secret values); assumed valid above:');
  for (const k of assumed) console.log(`  - ${k}`);
  console.log('\nThese still need a human check for the rules the contract enforces:');
  console.log('  - SEROS_SESSION_SECRET, SEROS_SIGNING_SECRET, CRON_SECRET: each >= 16 chars');
  console.log('  - DATABASE_URL: must start postgres:// or postgresql://');
}

async function main(): Promise<void> {
  if (!LIVE_PROBE_URL) {
    reportUnverified();
    return;
  }

  console.log('\nNot readable locally (Vercel hides secret values); asking the deployment instead:');
  for (const k of assumed) console.log(`  - ${k}`);

  const probe = await probeLiveBoot(LIVE_PROBE_URL);
  const classification = classifyHiddenKeys(assumed, probe);
  for (const line of renderLiveProbe(probe, classification)) console.log(line);

  if (!probe.proven) {
    // The operator asked for live proof and did not get it. Silently degrading to
    // "needs a human check" would let a broken deployment pass a green pipeline.
    process.exitCode = 1;
  }
}

main().catch((e: any) => {
  console.error(`live probe failed: ${String(e?.message ?? e)}`);
  process.exitCode = 1;
});
