# Maintaining a HolyDeck deployment

Routine procedures for the supported deployment in `compose.yaml` (DEPL-01): checking a
deployment is safe to start or upgrade, restarting it, rolling back a migration, and rotating a
secret.

## Deployment preflight

Before starting or upgrading a deployment, run the preflight check against the settings and
database it will use. It catches a bad deploy before it starts, rather than after:

```sh
node dist/deploy-preflight-cli.js   # from apps/app; or: pnpm run deploy-preflight
```

It exits `0` when every check is ready, or `1` and prints every problem it found — not just the
first — so an operator can fix everything in one pass. Like `migrate.js`, it exits `2` if no
durable store is configured at all.

Three checks, each independently provable to fail (see `apps/app/src/deploy-preflight.test.ts`,
which forces every one of them to fail and asserts it does):

- **configuration** — the same validation `loadSettings` runs at boot; problems are reported
  without ever printing a secret value.
- **migration** — refuses a schema version the build doesn't recognize (behind an unknown
  version, or ahead of what this build ships), and refuses if a pending migration has no
  recorded rollback path.
- **backup** — refuses if the most recent recorded backup is older than the recovery point
  objective (`RECOVERY_OBJECTIVES.rpoMinutes` in `apps/app/src/restores.ts`).

## Restarting

A planned restart interrupts live sessions briefly while the container is down. It does not lose
their place: presentation-run state (`apps/app/src/runs.ts`) is written to MongoDB as it changes,
not held only in the process's memory, so a run resumes from its last persisted position once the
application is back up. `apps/app/src/runs.integration.test.ts` proves this against a genuine
reconnect — it drops the original database connection entirely and opens a fresh one before
calling `resume`.

There is no separate "restart" command to learn: `restart: unless-stopped` in `compose.yaml`
already restarts `app` and `worker` on a crash or host reboot, and `docker compose up -d --pull
always` (or a new image tag) is how an operator restarts deliberately to pick up a new build.
Run the deployment preflight first — a restart onto a broken configuration is still a broken
configuration.

## Rolling back a migration

```sh
node dist/migrate.js --rollback   # undoes the newest applied schema version
```

Exercised by `apps/app/src/migrations.test.ts` and `apps/app/src/migrations.integration.test.ts`,
and guarded going forward by the deployment preflight's migration check, which refuses to let a
pending migration ship without a working rollback in the first place.

## Rotating a secret

The corpus token and the MongoDB credential (`HOLYDECK_CORPUS_TOKEN`, and the password embedded
in `HOLYDECK_MONGO_URL`) are the two secrets a deployment holds. To rotate either:

1. Generate a new value and update it wherever the deployment reads its settings from — the
   `HOLYDECK_*` environment, or `config/settings.yaml` (see `compose.yaml`'s comment on where
   that file lives).
2. Restart the affected service(s).
3. On boot, `loadSettings` reads the new value, and the redaction subsystem
   (`apps/app/src/redaction.ts`) builds a fresh redactor from it — the new secret is protected in
   every log line, error envelope and audit entry from that point on, and the old value is no
   longer this deployment's secret to protect.

`apps/app/src/redaction.test.ts`'s `rotating a secret` test exercises exactly this sequence: it
reloads settings with a rotated credential and asserts the new value is redacted while the
retired one is left as plain text, because protecting a value nobody uses anymore only makes the
real secret harder to find in a log.

A restart is required for a rotation to take effect — settings are read once at boot, not
watched for changes while running.

## Node baseline checkpoint (DEPL-03)

**Decision, recorded 2026-09-21: stay on Node 24 for this release. Do not move to Node 26 yet.**
Node 26 was released around April 2026 and is not expected to enter its LTS window until around
October 2026 — about a month out from this checkpoint. Node 24.20.0 remains the pinned version
(`.nvmrc`, `README.md`); this entry is the explicit sign-off that the evaluation happened and
what it concluded, not a change to that pin. Revisit at the next such checkpoint, once Node 26 is
actually in its LTS window.
