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
which run every shipped `down()` — including against a database where the indexes it drops were
never created, which is what a migration that failed partway leaves behind.

The deployment preflight's migration check helps, but know what it actually checks: it refuses to
start a deployment whose database has a pending migration this build declares no `down()` for. That
is a check that a rollback *exists*, made against the database a deploy is about to touch. It is not
a proof that the rollback works, and it runs at deploy time, so it cannot stop a migration from
being written or shipped in the first place. What says a rollback works is the test suite above.

## Rotating a secret

A supported deployment holds two secrets: the corpus token (`HOLYDECK_CORPUS_TOKEN`) and the
backup repository password (`resticPassword` / `HOLYDECK_RESTIC_PASSWORD`). `HOLYDECK_MONGO_URL`
can carry a third — a URL of the form `mongodb://user:password@host/db` — and is redacted from
every log line and settings response when it does, but `compose.yaml` runs MongoDB without
authentication and reaches it over the deployment's private network only, so by default there is
no credential in it to rotate.

The corpus token rotates the plain way. To rotate it (or a MongoDB credential, if this deployment
has given itself one):

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

### The backup repository password

The `restic` repository every backup is written into is encrypted, and `resticPassword` is what
opens it. Nothing asks an operator to invent one: the first time the worker boots without a
password it generates a 64-character random value and writes it into `config/settings.yaml`
alongside every other setting, atomically, the same way any settings change is written. An
operator who would rather hold the secret outside the deployment sets `HOLYDECK_RESTIC_PASSWORD`
instead, and a generated value is never written over the top of one that is already set.

**Keep a copy of this value somewhere the deployment is not.** It is deliberately redacted out of
the settings file the backup itself carries (`redactSettingsText` in `apps/app/src/settings.ts`) —
a repository password stored inside the repository protects nothing. The consequence is the part
worth planning for: if the host is lost and the only copy of `config/settings.yaml` went with it,
the backups on the surviving disk cannot be opened. Write the value down when the deployment is
first brought up, and store it wherever this deployment's other recovery material lives.

Rotating it is not a settings change on its own. Every snapshot already in the repository is
encrypted under the current password, so the repository has to be re-keyed first, from inside the
worker container, with the current password in hand:

```sh
docker compose exec -e RESTIC_PASSWORD="$CURRENT" worker \
  restic -r /data/holydeck/restic key passwd
```

Then put the new value in `config/settings.yaml` (or `HOLYDECK_RESTIC_PASSWORD`), restart the
worker, and record the new value wherever the old one was kept. Changing the setting without
re-keying first leaves a repository nothing can open and backup runs that fail on every attempt —
`apps/worker/src/restic.ts` refuses to run any command at all without a password rather than
quietly writing an unencrypted repository, so the failure is loud, but the snapshots already taken
are only recoverable with the password they were written under.

## Upgrading a deployment

The corpus image was renamed from `ghcr.io/holydeck/server` to `ghcr.io/holydeck/corpus`. For one
deprecation window, until the first stable release after v1.0, the same digest is also published
under the old name. The `corpus` service in `compose.yaml` likewise retains a `server` network
alias so existing services inside the deployment network continue to resolve it during the window.
New deployments and upgrades should use `corpus` and must not rely on the old image or network
aliases remaining after that window.

Before upgrading, run the [deployment preflight](#deployment-preflight). Then set
`HOLYDECK_VERSION` in `.env` or the shell environment read by `compose.yaml` to the desired tag —
a specific version, or the moving `latest` or `next` pointer; see `.env.example` — and apply it:

```sh
docker compose up -d --pull always
```

## Node baseline checkpoint (DEPL-03)

**Decision, recorded 2026-09-21: stay on Node 24 for this release. Do not move to Node 26 yet.**
Node 26 was released around April 2026 and is not expected to enter its LTS window until around
October 2026 — about a month out from this checkpoint. Node 24.20.0 remains the pinned version
(`.nvmrc`, `README.md`); this entry is the explicit sign-off that the evaluation happened and
what it concluded, not a change to that pin. Revisit at the next such checkpoint, once Node 26 is
actually in its LTS window.
