# Seros — application

> **Paused, not cancelled.** Seros, LLC is a
> [solution development company](https://seros.dev). This application is not deployed, not
> sold, and has no sign-up. It stays public as evidence of how we build.
>
> The decision record is `business/PIVOT-DECISION.md` (private). Do not deploy this without
> an explicit decision from the owner that reverses the pivot.

Turns what a team already said into confirmed, owned, dated tasks. Ingest a message, detect
a commitment, draft a task, **show it to a human**, and only then write anything anywhere.

TypeScript on Node. Express, Drizzle, SQLite locally and Postgres in production. No client
framework — the UI is server-rendered, escaped HTML.

## The invariant

**Nothing is written to a customer's tracker without a recorded human confirmation.**

Enforced by the schema, not by discipline: a `Task` row can only be created from a
`Confirmation` id, and no function in this repository creates one from a draft. See
[ADR 0002](https://github.com/Seros-LLC/seros/blob/main/docs/adr/0002-human-confirmation-is-mandatory.md).

Everything below is downstream of that one rule.

## Run it

```bash
npm install
# Required even locally. Generate unique values and do not commit them.
export SEROS_SESSION_SECRET="$(openssl rand -hex 32)"
export SEROS_SIGNING_SECRET="$(openssl rand -hex 32)"
npm run migrate                         # creates .seros/seros.db
SEROS_WORKSPACE=local-dev npm run seed  # optional; creates no demo workspace
npm run dev                             # web app on http://localhost:3000
npm run worker                          # background worker, second terminal
```

Sign in at <http://localhost:3000/login> with a credential printed by `npm run seed`. There
is no synthetic `/demo` route. To exercise the real loop, connect a Slack development
workspace and pick channels from the authenticated UI.

`npm run verify` is the gate — typecheck, tenancy check, and the full suite. It must stay
green while the product is paused.

| Command | What it does |
|---|---|
| `npm run dev` | the web app, watch mode |
| `npm start` | the built web app (`npm run build` first) |
| `npm run worker` | detection, drafting, and the tracker writer |
| `npm run verify` | **typecheck + tenancy check + tests** |
| `npm test` | 242 tests, offline, no keys |
| `npm run test:pg` | Postgres integration tests; needs a running database |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:tenancy` | fails if any module reaches past `WorkspaceScope` |
| `npm run eval` | scores detection against the 217-example golden set |
| `npm run migrate` | applies `.seros/migrations/*.sql`, idempotent |
| `npm run seed` | optional local bootstrap; no demo workspace |
| `npm run invite -- <memberId>` | single-use password setup link, from a host shell |
| `npm run set-password -- <memberId>` | sets a member password, from a host shell |
| `npm run sweep` | purges source content and old jobs past each retention window |
| `npm run prune` | removes expired webhook replay nonces |
| `npm run limits` | expires stale drafts, reports queue and draft caps |
| `npm run replay:capture -- <workspaceId> [--days N]` | read-only: replays the last N days (default 7) and reports missed commitments. Writes nothing |

`make dev`, `make worker`, `make test`, `make verify`, `make migrate` and `make seed` wrap
the same commands.

## How it works

### Tenancy

Tenant rows are reachable **only** through `WorkspaceScope`. It cannot be constructed
without an existing workspace, it injects `workspace_id` into every query itself, and it
exposes no raw database handle. Every tenant table carries `workspace_id` in its primary
key, so a row cannot exist outside a workspace and no unique constraint is global.

There is exactly one cross-tenant path — the queue poller in `db/system.ts` — and it reads
identifiers, never content. `npm run check:tenancy` fails the build if anything reaches
past the scope.

### Connecting Slack, and what "we only read these" means

`/connect` installs the Slack app (owner or admin only) and lists the scopes verbatim
before the redirect. `/channels` is the picker. A channel that is not ticked is not read:
the webhook drops the event **before** `source_messages`, so an unticked channel leaves no
row to delete later. Disconnecting destroys the stored token and the team no longer
resolves to a tenant, so ingestion stops.

The tenant is resolved from the stored connection (`source_connections.team_id`), never
from the event payload. A signed event for a team nobody has connected is refused.

### The tracker write

v0 writes to exactly one tracker. Which one is configuration, not code: `SEROS_TRACKER=linear`
with a key, or `fake` for tests and local work. An unknown value fails the boot rather than
silently writing confirmed tasks into a tracker nobody can see.

The write is two-phase, and the order is the point. A `task_writes` row is the claim; the
tracker is called; only when it answers with an id does `tasks.write_state` become
`created`. Before this, the task was marked `created` first, so a failed call left a task
that claimed to exist in a tracker it had never reached and the retry skipped it — a
confirmed commitment that silently never arrived. `tests/tracker-write.test.ts` holds that
case open.

### The model boundary

`src/provider/` is the only place in the codebase that talks to a model, and the only thing
permitted to open a socket to one. One operation, no streaming, no tools, no vendor type
escapes the directory. It refuses to run without a meter context, checks the budget before
the network call, and writes exactly one `action_meter` row on every terminating path —
`ok`, `timeout`, `invalid_output`, `provider_error`, `budget_blocked`.

**The transport chain** is ordered configuration, `SEROS_PROVIDER_CHAIN`:

| Setting | Meaning |
|---|---|
| `ollama` *(default)* | local Qwen `qwen2.5:7b-instruct`, and nothing behind it |
| `http,ollama` | a hosted provider first, **local Qwen as the backup** when it fails |
| `ollama,fake` | accept a regex-grade answer rather than none — a decision, written down |

A chained call is still one metered row, and the provider string records which link actually
served it: `ollama:qwen2.5:7b-instruct(after:http)`. No vendor has been chosen yet (ADR 0004
is still open), so today the chain is Qwen alone; the moment a hosted model goes in front,
Qwen becomes exactly what it should be — the thing that keeps the product working when
someone else's API is having an afternoon.

**A failed call invents nothing.** It returns `ok: false, value: null`, the job retries with
backoff, and the human sees no draft rather than a fabricated one. The deterministic fake is
a real transport, but it is only ever reached when it is named on purpose —
`SEROS_PROVIDER=fake` for tests and CI, or written into the chain. Quietly fabricating an
answer and presenting it as a model result was a review finding, not a feature.

### Guards over the model

A 7b model will happily invent a due date. `src/sanitize.ts` refuses:

- A date is kept **only** if the message actually states one — an ISO date, a numeric date,
  "today"/"tomorrow" that matches, or a named weekday that really is that weekday within
  seven days. Anything else becomes `null` and the human fills it in.
- The owner must map to a real member of the workspace. "Send the deck **to Priya**"
  proposes Priya, who is the recipient, not the person who committed — so it falls back to
  the message author, and the mapping is recorded.

Both behaviours are covered by tests, and dropping a date writes an audit row.

### Audit and metering

Every state change writes an audit row; every model call writes an `action_meter` row with
its outcome (`ok`, `timeout`, `invalid_output`, `provider_error`, `budget_blocked`). Browse
them at `/audit`.

## Detection quality

Measured on the 217-example golden set (`npm run eval`), which prints a threshold sweep so
the operating point is chosen from evidence rather than taste:

| Corpus | Provider | Prompt | Precision | Recall | F1 |
|---|---|---|---|---|---|
| 217 | `ollama:qwen2.5:7b-instruct` | detect/v2 | **100.0%** | 95.8% | 97.9% |
| 122 | `ollama:qwen2.5:7b-instruct` | detect/v2 | 100.0% | 89.8% | 94.6% |
| 122 | `ollama:qwen2.5:7b-instruct` | detect/v1 | 81.0% | 95.9% | 87.9% |
| 122 | deterministic fake | — | 80.0% | 65.3% | 71.9% |

Zero false positives across 217 examples, and the sweep is flat from 55 to 85, which means
the operating point is not balanced on a knife edge. Precision is the number that matters:
a missed commitment costs nothing, a wrong task in someone's tracker costs trust.

**How v2 happened, because it is the argument for keeping the harness.** v1 lost eleven
false positives to a single family — statements about where a person will *be*, what they
will *not* do, and what a *system* will do on its own: "I'll be out Friday", "I won't be in
the office Thursday", "The bot will send reminders". The model rated every one of them 100,
so the sweep showed no threshold could rescue it; precision peaked at 86% and stayed there.
The instruction changed instead, and the false positives went to zero. Prompts are versioned
in `src/prompts.ts` and the version is recorded on every metered call, so a rollback is a
flag flip.

The golden set itself was written by the same local Qwen — 197 of its 217 examples,
generated in about a minute of GPU time as synthetic fixtures (the brief requires fixtures
be synthetic), then read and labelled by hand. Three were thrown out: one "hard negative"
that was a real commitment, one that drifted into Chinese, and one too ambiguous to label
honestly. `SEROS_EVAL_SHOW_TEXT=1` prints the misclassified ones; by default the harness
prints counts, because one day it will be pointed at a consented corpus and printing text
should not be the habit it has by then.

```bash
SEROS_PROVIDER=fake npm run eval                 # force the backup
OLLAMA_HOST=http://127.0.0.1:59999 npm run eval  # prove the fallback works
```

## Layout

```
src/
  server.ts            express app, security headers, routes
  worker.ts            detect -> draft -> queue, and the tracker writer
  sanitize.ts          guards over model output
  prompts.ts           versioned prompts (detect/v2)
  views.ts             server-rendered HTML, escaped, no client framework
  provider/index.ts    the whole model boundary
  db/
    schema.ts          drizzle tables
    scope.ts           WorkspaceScope: the only way to touch tenant rows
    system.ts          the single cross-tenant path (the queue poller)
    client.ts          connection + migrations
  routes/              ask, confirm, connect, cron, digest, login, queue, webhook
.seros/
  migrations/*.sql     idempotent, applied in order
evals/                 golden set (217) + precision/recall scorer
tests/                 node:test, offline
tools/                 tenancy, prod-env and Postgres test scripts
```

## Signing in

Email and password only. There is no provider sign-in: a member receives an invite link,
sets a password, and signs in with it. Passwords are scrypt-hashed, sign-in is rate-limited
and locks out after repeated failures, and a CAPTCHA guards the form.

Account recovery is deliberately manual, because a self-serve reset on a workspace this
small is a larger attack surface than it is a convenience. `npm run invite` and
`npm run set-password` both need database access, so possession of the DB is the recovery
factor.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string; required on Vercel | SQLite locally if not `postgres://` |
| `SEROS_DB` | SQLite file path | `.seros/seros.db` |
| `SEROS_SESSION_SECRET` | Session signing key (min 16 chars) | **required** |
| `SEROS_SIGNING_SECRET` | Slack request-signing secret (min 16 chars) | **required** |
| `SEROS_ENCRYPTION_KEY` | 32 bytes (base64 or hex) sealing stored Slack tokens | **required to connect Slack** |
| `SEROS_DETECT_THRESHOLD` | Detection confidence threshold (0–100) | `55` |
| `SEROS_TRACKER` | Which tracker receives confirmed tasks: `linear` when configured; empty means Linear is deferred and tasks remain queued; `fake` only for tests/local work | empty in production |
| `LINEAR_API_KEY` | Linear personal API key, required when `SEROS_TRACKER=linear` | — |
| `LINEAR_TEAM_ID` | Linear team the issues are created in | — |
| `SEROS_TRACKER_TIMEOUT_MS` | Tracker HTTP timeout | `15000` |
| `SEROS_SLACK` | Slack client: `http` in production, `fake` only for tests/local work | `fake` locally |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack app credentials for the install flow | — |
| `SEROS_PUBLIC_URL` | Public base URL, for the OAuth redirect | request host |
| `PGPOOL_MAX` / `PGPOOL_IDLE_MS` / `PGPOOL_CONNECT_MS` / `PGSCHEMA` | Postgres pool and schema tuning | `1` / `10000` / `10000` / `public` |

Never put secret values in Git or paste them into logs.

To run against Postgres locally, set `DATABASE_URL` to a `postgresql://` connection string
and `SEROS_DB=""` to force it, then `npm run migrate`.

## If the pivot is ever reversed

Deployment is documented here rather than performed. Production is fail-closed: the boot
contract refuses to start without real configuration, and **no environment variable should
be set to work around it**.

The app targets Vercel — serverless functions via `/api/index.ts`, migrations on cold start,
a daily cron at 9:00 UTC for `/api/cron/drain`, security headers with HTTPS enforcement, and
connection pooling for Neon Postgres. Before any release:

```bash
npx vercel env pull /tmp/seros-prod.env --environment production --yes
npm run check:prod-env -- /tmp/seros-prod.env
# To prove Vercel-hidden values through the deployed boot contract:
npm run check:prod-env -- /tmp/seros-prod.env --live-probe https://app.seros.dev
rm -f /tmp/seros-prod.env
```

The checker must pass before release. Production requires `SEROS_SLACK=http`, real Slack
OAuth credentials, a hosted HTTPS provider configuration, and no fake tracker or demo
workspace. Linear is intentionally deferred: leave `SEROS_TRACKER` empty until Linear is
configured. Confirmed tasks remain queued securely and are never sent to a fake tracker.

Slack's OAuth redirect URI must be exactly
`https://app.seros.dev/connect/slack/callback`. The Slack app should request only the scopes
listed on `/connect`; the install flow stores the bot token encrypted and binds the callback
to the authenticated workspace member.

Before first customer use, complete one real Slack installation, select at least one channel,
send a consented test commitment, confirm it in Seros, and verify exactly one Linear issue is
created. Use the provider's own logs and Linear's issue history for that test; do not use a
demo workspace.

## Notes on tooling

There is no linter. ESLint is not a dependency and the legacy config has been removed rather
than left as documentation for something that fails. The gates that actually run are
`npm run typecheck`, `npm run check:tenancy` and `npm test` — all three together as
`npm run verify`. Tests are `node:test` via `tsx --test`, offline, and need no keys.

## Related repositories

| Repository | What it is |
|---|---|
| [`seros`](https://github.com/Seros-LLC/seros) | The specification behind this code: architecture, data model, ADRs, security controls, runbook |
| [`website`](https://github.com/Seros-LLC/website) | seros.dev |
