# Infrastructure

Task 2 provides Docker Compose definitions, a Caddy reverse proxy, and tested PostgreSQL backup/restore workflows. It does not create the Prisma schema or any business data.

## Security boundaries

- PostgreSQL has no host port mapping and joins only an internal Docker network.
- Caddy binds to host loopback only; Tailscale Serve will terminate private HTTPS in a later production-deployment task.
- PostgreSQL credentials come from an external file via Docker secrets. Secret values are never committed.
- Development Mailpit exposes only its web UI on host loopback; SMTP remains on the internal network.
- A disabled-by-default `maintenance` profile mounts the attachment volume with no network. It runs only one-off backup/restore commands.
- Production API/Web image placeholders are not started in task 2.

## Prepare development configuration

```bash
cp infra/env/dev.env.example infra/env/dev.env
install -d -m 700 infra/secrets/local
openssl rand -base64 48 > infra/secrets/local/dev-postgres-password.txt
chmod 600 infra/secrets/local/dev-postgres-password.txt
```

Edit `infra/env/dev.env` and set `POSTGRES_PASSWORD_FILE` to the absolute secret-file path. Pass backup locations explicitly with `--backup-dir`; backup scripts reject paths inside the repository. Local env files and secret values are ignored by Git.

## Static checks

```bash
pnpm infra:check
```

## Real disposable verification

```bash
COMPOSE_PROJECT_NAME=project-operations-center-verify \
  infra/scripts/verify-infrastructure.sh \
  --env-file infra/env/dev.env \
  --backup-dir /absolute/path/to/project-operations-center-backups
```

The verification creates only temporary `infra_verify` data, recreates the PostgreSQL container while preserving its named volume, restores a custom-format backup into a temporary database, validates attachment persistence and exact-content restore through new one-off containers, validates Caddy formatting/syntax, and removes temporary validation content. Its exit trap runs profile-aware cleanup automatically.

If the process is interrupted, rerun the guarded cleanup command with the same disposable project name. It removes every verification volume, including the attachment volume owned by the disabled maintenance profile:

```bash
COMPOSE_PROJECT_NAME=project-operations-center-verify \
  infra/scripts/cleanup-verification.sh --env-file infra/env/dev.env
```

The verification and cleanup scripts refuse Compose project names that do not explicitly contain `verify`. Never run `down --volumes` against production data.

## Backup boundaries

Database and attachment backups are deliberately separate artifacts:

```bash
infra/scripts/backup.sh \
  --env-file infra/env/dev.env \
  --backup-dir /absolute/path/to/project-operations-center-backups
infra/scripts/backup-attachments.sh \
  --env-file infra/env/dev.env \
  --backup-dir /absolute/path/to/project-operations-center-backups
```

Each artifact has a SHA-256 sidecar. Attachment restore rejects absolute paths, traversal, links, and special archive members before it can access the Docker volume, and requires `CONFIRM_ATTACHMENTS_RESTORE=YES`.

These local development backups are **not** a production-consistent recovery point. Before real business data is enabled, one coordinated procedure must quiesce writes, create both artifacts under the same recovery-point identifier, copy them to encrypted off-machine storage, and prove a joint restore.
