# Secrets

Do not commit secret values. Compose reads the PostgreSQL password from an external file named by `POSTGRES_PASSWORD_FILE`.

Create a local development secret with restrictive permissions, then point `infra/env/dev.env` at its absolute path:

```bash
install -d -m 700 infra/secrets/local
openssl rand -base64 48 > infra/secrets/local/dev-postgres-password.txt
chmod 600 infra/secrets/local/dev-postgres-password.txt
```

Production secrets must be stored outside the repository and backed up through an approved secret-management process.
