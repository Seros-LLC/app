import { isPgUrl } from './db/driver';

const requireSecret = (env: NodeJS.ProcessEnv, name: string): void => {
  const value = env[name];
  if (!value || value.length < 16) {
    throw new Error(`${name} is unset or too short (>=16 chars required)`);
  }
};

/**
 * Vercel has no durable writable filesystem. Refuse to boot unless the deployment
 * has real signing material and a Postgres database. Keeping this pure makes the
 * fail-closed contract directly testable without importing the serverless handler.
 */
/**
 * A serverless deployment has no localhost, so an `ollama` transport can never
 * answer there. Booting without a reachable provider produced the worst failure
 * mode we have: the app reports healthy, accepts Slack events, and silently
 * drafts nothing, because the transport error surfaces one request at a time and
 * never at startup. Refuse the deployment instead of shipping a queue that stays
 * empty for reasons no operator can see.
 */
const requireHostedProviderUrl = (env: NodeJS.ProcessEnv): void => {
  const raw = env.SEROS_PROVIDER_BASE_URL;
  if (!raw) throw new Error('SEROS_PROVIDER_BASE_URL is required when the chain includes `http`');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('SEROS_PROVIDER_BASE_URL must be an absolute HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('SEROS_PROVIDER_BASE_URL must be HTTPS without credentials or fragments');
  }
  const allowed = (env.SEROS_PROVIDER_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new Error('SEROS_PROVIDER_BASE_URL host must appear in SEROS_PROVIDER_ALLOWED_HOSTS');
  }
};

const requireProductionIntegrations = (env: NodeJS.ProcessEnv): void => {
  if ((env.SEROS_SLACK || '').trim().toLowerCase() !== 'http') {
    throw new Error('SEROS_SLACK must be http on Vercel: the fake Slack client is not a production integration');
  }
  // Linear is intentionally deferred. Confirmed tasks remain queued until a real
  // tracker is configured; they must never be written to a fake provider.
  const tracker = (env.SEROS_TRACKER || '').trim().toLowerCase();
  if (tracker === 'fake') {
    throw new Error('SEROS_TRACKER=fake must never serve a deployment');
  }
  if (tracker && tracker !== 'linear') {
    throw new Error('SEROS_TRACKER must be empty or linear on Vercel');
  }
  const workspace = (env.SEROS_WORKSPACE || '').trim().toLowerCase();
  if (workspace && (workspace === 'demo' || workspace.endsWith('.invalid'))) {
    throw new Error('SEROS_WORKSPACE must not be a demo or placeholder workspace');
  }
  // Signup creates real tenants. A configured workspace is optional because
  // production must not depend on a pre-seeded/demo tenant.
  requireSecret(env, 'SEROS_ENCRYPTION_KEY');
  if (tracker === 'linear') {
    requireSecret(env, 'LINEAR_API_KEY');
    if (!env.LINEAR_TEAM_ID) {
      throw new Error('LINEAR_TEAM_ID is required when SEROS_TRACKER=linear');
    }
  }
  // OAuth is required only when the Slack connect flow is used; the app can
  // boot and serve existing tenants while an operator finishes setup.
};

const requireUsableProvider = (env: NodeJS.ProcessEnv): void => {
  requireProductionIntegrations(env);
  if (env.SEROS_PROVIDER === 'fake') {
    throw new Error('SEROS_PROVIDER=fake must never serve a deployment: it fabricates model output');
  }
  const chain = (env.SEROS_PROVIDER_CHAIN || 'ollama')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (chain.includes('fake')) {
    throw new Error('SEROS_PROVIDER_CHAIN must not contain `fake` on Vercel: it fabricates model output');
  }
  if (!chain.includes('http')) {
    throw new Error(
      'SEROS_PROVIDER_CHAIN must include `http` on Vercel: the default `ollama` transport ' +
      'points at localhost:11434, which does not exist in a serverless runtime, so every ' +
      'draft would fail silently',
    );
  }
  if (!env.SEROS_PROVIDER_API_KEY) {
    throw new Error('SEROS_PROVIDER_API_KEY is required when the chain includes `http`');
  }
  requireHostedProviderUrl(env);
};

export function validateServerlessEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  requireSecret(env, 'SEROS_SESSION_SECRET');
  requireSecret(env, 'SEROS_SIGNING_SECRET');
  requireSecret(env, 'CRON_SECRET');
  if (!isPgUrl(env.DATABASE_URL)) {
    throw new Error('DATABASE_URL must be a postgres:// or postgresql:// URL on Vercel');
  }
  requireUsableProvider(env);
}
