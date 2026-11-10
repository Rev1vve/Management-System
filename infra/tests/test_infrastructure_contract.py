from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra"

EXPECTED_FILES = [
    INFRA / "compose.dev.yml",
    INFRA / "compose.prod.yml",
    INFRA / "Caddyfile",
    INFRA / "README.md",
    INFRA / "RESTORE-DRILL.md",
    INFRA / "env" / "dev.env.example",
    INFRA / "env" / "prod.env.example",
    INFRA / "secrets" / ".gitignore",
    INFRA / "scripts" / "backup.sh",
    INFRA / "scripts" / "deploy.sh",
    INFRA / "scripts" / "install-backup-timer.sh",
    INFRA / "scripts" / "prune-backups.sh",
    INFRA / "scripts" / "seed-drill-data.sh",
    INFRA / "scripts" / "backup-offsite.sh",
    INFRA / "scripts" / "install-offsite-timer.sh",
    INFRA / "scripts" / "rollback.sh",
    INFRA / "scripts" / "tailscale-serve.sh",
    INFRA / "scripts" / "backup-attachments.sh",
    INFRA / "scripts" / "cleanup-verification.sh",
    INFRA / "scripts" / "restore.sh",
    INFRA / "scripts" / "restore-attachments.sh",
    INFRA / "scripts" / "verify-attachments.sh",
    INFRA / "scripts" / "verify-backup-restore.sh",
    INFRA / "scripts" / "verify-persistence.sh",
    INFRA / "scripts" / "verify-infrastructure.sh",
]

SCRIPT_FILES = [path for path in EXPECTED_FILES if path.suffix == ".sh"]


def run(command: list[str], *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )


def _has_gnu_toolchain() -> bool:
    """POSIX 契约要求「POSIX 平台 + GNU coreutils」，两者缺一不可。

    只探测工具存在是不够的：Git for Windows / MSYS 也提供 bash + GNU coreutils，
    但路径分隔符、换行、rmdir 与 `mv -nT` 语义仍不同，契约会红而非跳过
    （2026-11-06 实测 3 failures + 1 error）。因此这里同时要求非 Windows 平台；
    macOS 因为缺少 sha256sum / GNU mv 也会被判为不可用。
    """
    if os.name == "nt":
        return False
    required = ("bash", "sha256sum", "mv", "tar", "sed")
    if any(shutil.which(name) is None for name in required):
        return False
    probe = subprocess.run(
        ["mv", "--version"], capture_output=True, text=True, check=False
    )
    return "GNU coreutils" in (probe.stdout or "")


POSIX_SHELL = _has_gnu_toolchain()

# 依赖缺失时跳过（并写明真实依赖），由 ubuntu-latest CI 覆盖。
requires_posix_shell = unittest.skipUnless(
    POSIX_SHELL,
    "需要 POSIX shell + GNU coreutils（bash/sha256sum/GNU mv/tar/sed）；本机缺失时跳过，由 ubuntu-latest CI 覆盖",
)
requires_docker = unittest.skipUnless(
    shutil.which("docker") is not None,
    "需要 Docker CLI；本机未安装，由 ubuntu-latest CI 覆盖",
)


class PosixToolchainAvailabilityTests(unittest.TestCase):
    """防止"工具缺失 → 静默跳过"把 10 项契约变成永远不跑。

    CI（ubuntu-latest）必须真的具备 POSIX + GNU coreutils；一旦镜像变化导致缺失，
    这里会红，而不是让契约悄悄变成 skipped。
    """

    def test_linux_ci_has_posix_toolchain(self) -> None:
        if not sys.platform.startswith("linux"):
            self.skipTest("仅约束 Linux CI 环境")
        self.assertTrue(
            POSIX_SHELL,
            "Linux 上必须能执行 POSIX 契约（缺 bash/sha256sum/GNU mv/tar/sed 之一）",
        )

    def test_linux_ci_has_docker_cli(self) -> None:
        if not sys.platform.startswith("linux"):
            self.skipTest("仅约束 Linux CI 环境")
        self.assertIsNotNone(
            shutil.which("docker"),
            "Linux CI 必须带 Docker CLI，否则 Compose 网络契约会被静默跳过",
        )


class InfrastructureContractTests(unittest.TestCase):
    def test_expected_task_two_files_exist(self) -> None:
        missing = [str(path.relative_to(ROOT)) for path in EXPECTED_FILES if not path.is_file()]
        self.assertEqual(missing, [], f"missing task 2 files: {missing}")

    @requires_docker
    def test_compose_configs_render_with_private_database_network(self) -> None:
        self.assertIsNotNone(shutil.which("docker"), "docker CLI is required for Compose validation")

        with tempfile.TemporaryDirectory() as temp_dir:
            secret_path = Path(temp_dir) / "postgres-password"
            secret_path.write_text("contract-test-only\n", encoding="utf-8")
            mfa_secret_path = Path(temp_dir) / "mfa-secret-key"
            mfa_secret_path.write_text("c" * 64 + "\n", encoding="utf-8")
            env = os.environ.copy()
            env.update(
                {
                    "POSTGRES_PASSWORD_FILE": str(secret_path),
                    "MFA_SECRET_KEY_FILE": str(mfa_secret_path),
                    "APP_HTTP_PORT": "18080",
                    "MAILPIT_HTTP_PORT": "18025",
                }
            )

            for compose_file in (INFRA / "compose.dev.yml", INFRA / "compose.prod.yml"):
                self.assertTrue(compose_file.is_file(), f"missing {compose_file}")
                command = [
                    "docker",
                    "compose",
                    "-f",
                    str(compose_file),
                    "--profile",
                    "maintenance",
                ]
                if compose_file.name == "compose.prod.yml":
                    command.extend(["--profile", "application"])
                command.extend(["config", "--format", "json"])
                result = run(command, env=env)
                self.assertEqual(result.returncode, 0, result.stderr)
                config = json.loads(result.stdout)

                postgres = config["services"]["postgres"]
                self.assertFalse(postgres.get("ports"), "PostgreSQL must not publish host ports")
                self.assertRegex(postgres["image"], r"@sha256:[0-9a-f]{64}$")
                self.assertEqual(postgres["environment"]["POSTGRES_PASSWORD_FILE"], "/run/secrets/postgres_password")
                secret_sources = {secret["source"] for secret in postgres["secrets"]}
                self.assertIn("postgres_password", secret_sources)

                backend_network_names = set(postgres["networks"])
                self.assertTrue(backend_network_names, "PostgreSQL must join a backend network")
                self.assertTrue(
                    all(config["networks"][name].get("internal") is True for name in backend_network_names),
                    "every PostgreSQL network must be Docker-internal",
                )

                maintenance = config["services"]["attachments-maintenance"]
                self.assertRegex(maintenance["image"], r"@sha256:[0-9a-f]{64}$")
                self.assertEqual(maintenance.get("network_mode"), "none")
                self.assertEqual(maintenance.get("user"), "0:0")
                volume_sources = {volume["source"] for volume in maintenance["volumes"]}
                self.assertIn("attachments_data", volume_sources)
                self.assertIn("attachments_data", config["volumes"])

                if compose_file.name == "compose.dev.yml":
                    mailpit = config["services"]["mailpit"]
                    self.assertRegex(mailpit["image"], r"@sha256:[0-9a-f]{64}$")
                    for port in mailpit.get("ports", []):
                        self.assertEqual(port.get("host_ip"), "127.0.0.1")
                else:
                    api = config["services"]["api"]
                    self.assertEqual(api["environment"]["ATTACHMENTS_ROOT"], "/srv/attachments")
                    self.assertEqual(api.get("user"), "10001:10001")
                    api_volume_sources = {volume["source"] for volume in api["volumes"]}
                    self.assertIn("attachments_data", api_volume_sources)
                    self.assertEqual(
                        api["depends_on"]["attachments-init"]["condition"],
                        "service_completed_successfully",
                    )
                    initializer = config["services"]["attachments-init"]
                    self.assertEqual(initializer.get("user"), "0:0")
                    self.assertEqual(initializer.get("network_mode"), "none")
                    initializer_volume_sources = {
                        volume["source"] for volume in initializer["volumes"]
                    }
                    self.assertIn("attachments_data", initializer_volume_sources)
                    initializer_command = " ".join(initializer["command"])
                    self.assertIn("install -d -o 10001 -g 10001 -m 0700", initializer_command)
                    self.assertIn("UNSAFE_ATTACHMENT_ENTRY", initializer_command)
                    self.assertIn("-type d -exec chown 10001:10001", initializer_command)
                    self.assertIn("-type d -exec chmod 0700", initializer_command)
                    self.assertIn("-type f -exec chown 10001:10001", initializer_command)
                    self.assertIn("-type f -exec chmod 0600", initializer_command)
                    caddy = config["services"]["caddy"]
                    self.assertRegex(caddy["image"], r"@sha256:[0-9a-f]{64}$")
                    self.assertTrue(caddy.get("ports"), "production reverse proxy needs a loopback port")
                    for port in caddy["ports"]:
                        self.assertEqual(port.get("host_ip"), "127.0.0.1")

    def test_production_web_process_listens_on_compose_network(self) -> None:
        package = json.loads((ROOT / "apps" / "web" / "package.json").read_text(encoding="utf-8"))
        start = package["scripts"]["start"]
        self.assertIn(
            "${HOSTNAME:-127.0.0.1}",
            start,
            "the production web process must honor Compose HOSTNAME so Caddy can reach it",
        )
        production = (INFRA / "compose.prod.yml").read_text(encoding="utf-8")
        self.assertIn("HOSTNAME: 0.0.0.0", production)

    def test_api_tools_image_installs_openssl_for_prisma(self) -> None:
        dockerfile = (ROOT / "apps" / "api" / "Dockerfile").read_text(encoding="utf-8")
        self.assertRegex(
            dockerfile,
            r"apt-get install[^\n]*openssl",
            "Prisma's Debian tools image must install OpenSSL explicitly",
        )

    def test_quality_serializes_api_tasks_that_generate_the_same_prisma_client(self) -> None:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        quality = package["scripts"]["quality"]
        self.assertIn(
            "turbo run lint typecheck test --concurrency=1",
            quality,
            "API test and typecheck both run prisma generate into one ignored directory",
        )

    def test_api_production_image_is_built_from_minimal_reviewed_runtime_stage(self) -> None:
        dockerfile = (ROOT / "apps" / "api" / "Dockerfile").read_text(encoding="utf-8")
        production = (INFRA / "compose.prod.yml").read_text(encoding="utf-8")
        self.assertRegex(dockerfile, r"(?m)^FROM .+ AS api-runtime$")
        self.assertIn("USER 10001:10001", dockerfile)
        self.assertRegex(dockerfile, r"apt-get install[^\n]*coreutils")
        self.assertIn("test -x /usr/bin/mv", dockerfile)
        self.assertIn(
            "pnpm install --filter @project-operations/api... --frozen-lockfile",
            dockerfile,
        )
        self.assertNotRegex(dockerfile, r"(?m)^RUN pnpm install --frozen-lockfile$")
        self.assertIn(
            "pnpm --filter @project-operations/api deploy --prod --legacy /runtime/api",
            dockerfile,
        )
        self.assertRegex(dockerfile, r"(?m)^FROM api-build AS api-deploy$")
        self.assertNotIn("COPY --from=api-build /workspace /workspace", dockerfile)
        self.assertIn("COPY --from=api-deploy /runtime/api/node_modules ./node_modules", dockerfile)
        self.assertIn("COPY --from=api-build /workspace/apps/api/dist ./dist", dockerfile)
        self.assertIn("COPY --from=api-build /workspace/apps/api/package.json ./package.json", dockerfile)
        self.assertIn(
            "COPY --from=api-build /workspace/apps/api/docker/db-tools-entrypoint.sh ./docker/db-tools-entrypoint.sh",
            dockerfile,
        )
        self.assertIn('CMD ["node", "dist/main.js"]', dockerfile)
        self.assertIn("dockerfile: apps/api/Dockerfile", production)
        self.assertIn("target: api-runtime", production)

    def test_attachment_restore_reapplies_private_runtime_ownership_and_modes(self) -> None:
        restore = (INFRA / "scripts" / "restore-attachments.sh").read_text(encoding="utf-8")
        self.assertIn("UNSAFE_ATTACHMENT_ENTRY", restore)
        self.assertIn("-type d -exec chown 10001:10001", restore)
        self.assertIn("-type d -exec chmod 0700", restore)
        self.assertIn("-type f -exec chown 10001:10001", restore)
        self.assertIn("-type f -exec chmod 0600", restore)

    def test_work_log_guard_hardening_covers_status_truncate_and_lock(self) -> None:
        migration = (
            ROOT
            / "apps"
            / "api"
            / "prisma"
            / "migrations"
            / "20260826000006_work_log_guard_hardening"
            / "migration.sql"
        )
        self.assertTrue(migration.is_file(), "work log guard hardening migration is missing")
        sql = migration.read_text(encoding="utf-8")
        self.assertIn("BEGIN;", sql)
        self.assertIn("COMMIT;", sql)
        # 0006 引入了状态机与父行锁；父行锁在 0007 被冻结列方案取代（见下一项）。
        self.assertIn('CREATE TRIGGER "work_logs_status_transition_guard"', sql)
        self.assertIn("DROP TRIGGER IF EXISTS", sql)

    def test_work_log_freeze_migration_removes_lock_and_truncate_reliance(self) -> None:
        migration = (
            ROOT
            / "apps"
            / "api"
            / "prisma"
            / "migrations"
            / "20260826000007_work_log_version_freeze"
            / "migration.sql"
        )
        self.assertTrue(migration.is_file(), "work log freeze migration is missing")
        sql = migration.read_text(encoding="utf-8")
        self.assertIn("BEGIN;", sql)
        self.assertIn("COMMIT;", sql)
        # 冻结列 + 只读判定：不再读父行，因此没有 FOR UPDATE 与快照窗口。
        self.assertIn('ADD COLUMN IF NOT EXISTS "frozen_at"', sql)
        self.assertIn('OLD."frozen_at" IS NOT NULL', sql)
        # 只允许在注释里提到旧方案；不得出现可执行的 FOR UPDATE 语句。
        self.assertNotIn("FOR UPDATE;", sql)
        # 顺序：必须先摘掉旧触发器再回填，否则带历史数据升级会失败（review-10 阻塞项）。
        self.assertLess(
            sql.index('DROP TRIGGER IF EXISTS "work_log_versions_immutable_guard"'),
            sql.index('UPDATE "work_log_versions" v'),
        )
        # 数据库兜底：状态离开 DRAFT 时冻结该日志下所有未冻结版本（不只当前指针）。
        self.assertIn('CREATE TRIGGER "work_logs_freeze_on_submit"', sql)
        self.assertIn('OLD."status" = \'DRAFT\' AND NEW."status" <> \'DRAFT\'', sql)
        self.assertIn('WHERE "work_log_id" = NEW."id" AND "frozen_at" IS NULL', sql)
        # 非草稿日志不得重指向、不得追加版本（否则可伪造展示内容）。
        self.assertIn('current version can only change while the work log is a draft', sql)
        self.assertIn('CREATE TRIGGER "work_log_versions_insert_guard"', sql)
        # 状态机补 INSERT 约束。
        self.assertIn('CREATE TRIGGER "work_logs_status_insert_guard"', sql)
        # 单角色部署下 TRUNCATE 守卫只是假守卫，必须显式撤掉而不是留着误导。
        self.assertIn('DROP TRIGGER IF EXISTS "work_log_versions_truncate_guard"', sql)
        # 升级前已提交的版本要先冻结，避免迁移把历史变成可改。
        self.assertIn('SET "frozen_at" =', sql)
        # 冻结列必须落到 Prisma schema，否则 migrate diff 会报 drift。
        schema = (ROOT / "apps" / "api" / "prisma" / "schema.prisma").read_text(encoding="utf-8")
        self.assertIn(
            'frozenAt      DateTime? @map("frozen_at") @db.Timestamptz(3)',
            schema,
        )

    def test_work_log_guards_migration_is_atomic_and_fail_closed(self) -> None:
        migration = (
            ROOT
            / "apps"
            / "api"
            / "prisma"
            / "migrations"
            / "20260826000005_work_log_version_guards"
            / "migration.sql"
        )
        self.assertTrue(migration.is_file(), "work log guard migration is missing")
        sql = migration.read_text(encoding="utf-8")

        # 显式事务：中途失败不能留下半个约束。
        self.assertIn("BEGIN;", sql)
        self.assertIn("COMMIT;", sql)
        # 升级前必须验证既有数据，不一致时拒绝迁移。
        self.assertIn("RAISE EXCEPTION 'work log version guard migration requires consistent", sql)
        # 两条不变量都要落到数据库：归属 + 追加写。
        self.assertIn('CREATE TRIGGER "work_logs_current_version_guard"', sql)
        self.assertIn('CREATE TRIGGER "work_log_versions_immutable_guard"', sql)
        self.assertIn("ON \"work_log_versions\"\nFOR EACH ROW", sql)
        # 草稿编辑是唯一允许的 UPDATE 场景。
        self.assertIn("log_status <> 'DRAFT'", sql)
        self.assertIn("DELETE", sql)

    def test_attachment_cleanup_migration_is_explicitly_atomic(self) -> None:
        migration = (
            ROOT
            / "apps"
            / "api"
            / "prisma"
            / "migrations"
            / "20260823000004_attachment_storage_cleanup"
            / "migration.sql"
        ).read_text(encoding="utf-8")
        executable = "\n".join(
            line for line in migration.splitlines() if line.strip() and not line.lstrip().startswith("--")
        )
        self.assertTrue(executable.startswith("BEGIN;\n"))
        self.assertTrue(executable.endswith("\nCOMMIT;"))
        self.assertEqual(executable.count("BEGIN;"), 1)
        self.assertEqual(executable.count("COMMIT;"), 1)

    def test_attachment_identity_migration_rejects_legacy_rows(self) -> None:
        migration = (
            ROOT
            / "apps"
            / "api"
            / "prisma"
            / "migrations"
            / "20260823000004_attachment_storage_cleanup"
            / "migration.sql"
        ).read_text(encoding="utf-8")
        guard = migration.index('IF EXISTS (SELECT 1 FROM "attachments")')
        alter = migration.index('ALTER TABLE "attachments"')
        self.assertLess(guard, alter)
        self.assertIn("RAISE EXCEPTION", migration)

    def test_customer_contract_attachments_have_a_fail_closed_customer_relation(self) -> None:
        schema = (ROOT / "apps" / "api" / "prisma" / "schema.prisma").read_text(encoding="utf-8")
        migration = (
            ROOT
            / "apps"
            / "api"
            / "prisma"
            / "migrations"
            / "20260823000004_attachment_storage_cleanup"
            / "migration.sql"
        ).read_text(encoding="utf-8")
        self.assertRegex(
            schema,
            r'(?m)^\s*customerId\s+String\?\s+@map\("customer_id"\)$',
        )
        self.assertRegex(
            schema,
            r'(?m)^\s*customer\s+Customer\?\s+@relation\(fields: \[customerId\], references: \[id\], onDelete: Restrict, onUpdate: Cascade\)$',
        )
        self.assertIn('attachments Attachment[]', schema)
        self.assertIn('ADD COLUMN "customer_id" TEXT', migration)
        self.assertIn('CONSTRAINT "attachments_customer_contract_consistency_check" CHECK', migration)
        self.assertIn('"resource_type" = \'CUSTOMER_CONTRACT\'', migration)
        self.assertIn('"resource_id" = "customer_id"', migration)
        self.assertIn('"resource_type" <> \'CUSTOMER_CONTRACT\'', migration)
        self.assertIn('"customer_id" IS NULL', migration)
        self.assertIn('attachments_customer_id_fkey', migration)

    def test_attachment_cleanup_index_name_is_postgres_safe_and_matches_schema(self) -> None:
        schema = (ROOT / "apps" / "api" / "prisma" / "schema.prisma").read_text(encoding="utf-8")
        migration = (
            ROOT
            / "apps"
            / "api"
            / "prisma"
            / "migrations"
            / "20260823000004_attachment_storage_cleanup"
            / "migration.sql"
        ).read_text(encoding="utf-8")
        index_name = "attachments_cleanup_pending_idx"
        self.assertLessEqual(len(index_name.encode("utf-8")), 63)
        self.assertIn(
            '@@index([status, storageDeletedAt, storageCleanupAttempts], map: "attachments_cleanup_pending_idx")',
            schema,
        )
        self.assertIn(f'CREATE INDEX "{index_name}"', migration)
        upload_index_name = "attachments_upload_pending_idx"
        self.assertLessEqual(len(upload_index_name.encode("utf-8")), 63)
        self.assertIn(
            '@@index([status, storagePublishedAt, storageCleanupAttempts], map: "attachments_upload_pending_idx")',
            schema,
        )
        self.assertIn(f'CREATE INDEX "{upload_index_name}"', migration)

    def test_no_hardcoded_postgres_password(self) -> None:
        for compose_file in (INFRA / "compose.dev.yml", INFRA / "compose.prod.yml"):
            self.assertTrue(compose_file.is_file(), f"missing {compose_file}")
            text = compose_file.read_text(encoding="utf-8")
            self.assertNotRegex(text, r"(?m)^\s*POSTGRES_PASSWORD\s*:")
            self.assertIn("POSTGRES_PASSWORD_FILE", text)
            self.assertIn("postgres_password", text)

    def test_compose_does_not_claim_unsupported_secret_modes(self) -> None:
        for compose_file in (INFRA / "compose.dev.yml", INFRA / "compose.prod.yml"):
            text = compose_file.read_text(encoding="utf-8")
            self.assertNotIn(
                "mode: 0400",
                text,
                "Compose file secrets are bind mounts and ignore uid/gid/mode",
            )

    def test_production_secret_files_use_the_runtime_group_with_no_world_access(self) -> None:
        production = (INFRA / "compose.prod.yml").read_text(encoding="utf-8")
        readme = (INFRA / "README.md").read_text(encoding="utf-8")
        example = (INFRA / "env" / "prod.env.example").read_text(encoding="utf-8")

        self.assertRegex(
            production,
            r"(?ms)^  postgres:.*?^    group_add:\n      - '10001'$",
            "PostgreSQL must receive only the supplementary group needed to read production secrets",
        )
        self.assertIn("MFA_SECRET_KEY_FILE=/absolute/path/to/prod-mfa-secret-key.txt", example)
        self.assertIn("chown root:10001", readme)
        self.assertIn("chmod 0440", readme)
        self.assertIn("root:10001:440", readme)

    def test_backup_directory_is_not_misrepresented_as_compose_env(self) -> None:
        for env_example in (
            INFRA / "env" / "dev.env.example",
            INFRA / "env" / "prod.env.example",
        ):
            self.assertNotIn("BACKUP_DIR", env_example.read_text(encoding="utf-8"))

        documentation = (INFRA / "README.md").read_text(encoding="utf-8")
        development_config = documentation.split(
            "## Prepare development configuration", 1
        )[1].split("## Static checks", 1)[0]
        self.assertNotIn("BACKUP_DIR", development_config)
        for script_name in ("backup.sh", "backup-attachments.sh"):
            command_start = documentation.index(f"infra/scripts/{script_name}")
            command_snippet = documentation[command_start : command_start + 220]
            self.assertIn("--backup-dir", command_snippet)

    @requires_posix_shell
    def test_backup_directory_must_be_outside_repository(self) -> None:
        library = INFRA / "scripts" / "lib.sh"
        result = run(
            [
                "bash",
                "-c",
                'source "$1"; BACKUP_DIR="$2"; require_backup_dir_outside_repo',
                "bash",
                str(library),
                str(INFRA / "backups"),
            ]
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("backup directory must be outside repository", result.stderr)

        for script_name in ("backup.sh", "backup-attachments.sh"):
            text = (INFRA / "scripts" / script_name).read_text(encoding="utf-8")
            self.assertIn("require_backup_dir_outside_repo", text)

    def test_verification_shutdown_uses_guarded_profile_aware_cleanup(self) -> None:
        documentation = (INFRA / "README.md").read_text(encoding="utf-8")
        verification_section = documentation.split(
            "## Real disposable verification", 1
        )[1].split("## Backup boundaries", 1)[0]
        self.assertNotIn("docker compose", verification_section)
        self.assertIn("COMPOSE_PROJECT_NAME=project-operations-center-verify", verification_section)
        self.assertIn("cleanup-verification.sh", verification_section)

    def test_verification_cleanup_failure_blocks_pass_marker(self) -> None:
        library = INFRA / "scripts" / "lib.sh"
        result = run(
            [
                "bash",
                "-c",
                """
source "$1"
cleanup() {
  printf 'cleanup_attempted\\n'
  return 1
}
register_verification_cleanup cleanup
finish_verification_cleanup
printf 'verification=PASS\\n'
""",
                "bash",
                str(library),
            ]
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cleanup_attempted", result.stdout)
        self.assertNotIn("verification=PASS", result.stdout)
        self.assertIn("verification cleanup failed", result.stderr)

    def test_infrastructure_verifier_owns_compose_cleanup(self) -> None:
        script = (INFRA / "scripts" / "verify-infrastructure.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn('"${SCRIPT_DIR}/cleanup-verification.sh"', script)
        guard = script.index("require_disposable_project")
        registration = script.index("register_verification_cleanup cleanup")
        startup = script.index("compose up --detach postgres")
        finish = script.index("finish_verification_cleanup")
        passed = script.index("infrastructure_verification=PASS")
        self.assertLess(guard, registration)
        self.assertLess(registration, startup)
        self.assertLess(finish, passed)

    def assert_subverifier_cleanup_is_fail_closed(
        self, script_name: str, pass_marker: str
    ) -> None:
        script = (INFRA / "scripts" / script_name).read_text(encoding="utf-8")
        cleanup_body = script.split("cleanup() {", 1)[1].split("\n}", 1)[0]
        self.assertNotIn("|| true", cleanup_body)
        registration = script.index("register_verification_cleanup cleanup")
        finish = script.index("finish_verification_cleanup")
        passed = script.index(pass_marker)
        self.assertLess(registration, finish)
        self.assertLess(finish, passed)

    def test_persistence_verifier_fails_closed_on_cleanup(self) -> None:
        self.assert_subverifier_cleanup_is_fail_closed(
            "verify-persistence.sh", "persistence_verification=PASS"
        )

    def test_database_verifier_fails_closed_on_cleanup(self) -> None:
        self.assert_subverifier_cleanup_is_fail_closed(
            "verify-backup-restore.sh", "backup_restore_verification=PASS"
        )

    def test_attachment_verifier_fails_closed_on_cleanup(self) -> None:
        self.assert_subverifier_cleanup_is_fail_closed(
            "verify-attachments.sh", "attachment_backup_restore_verification=PASS"
        )

    @requires_posix_shell
    def test_backup_publication_never_clobbers_existing_artifacts(self) -> None:
        library = INFRA / "scripts" / "lib.sh"
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            temporary_backup = directory / "new.partial"
            temporary_checksum = directory / "new.sha256.partial"
            final_backup = directory / "existing.dump"
            final_checksum = directory / "existing.dump.sha256"
            temporary_backup.write_text("new-backup", encoding="utf-8")
            temporary_checksum.write_text("new-checksum", encoding="utf-8")
            final_backup.write_text("existing-backup", encoding="utf-8")
            final_checksum.write_text("existing-checksum", encoding="utf-8")

            result = run(
                [
                    "bash",
                    "-c",
                    'source "$1"; publish_backup_pair "$2" "$3" "$4" "$5"',
                    "bash",
                    str(library),
                    str(temporary_backup),
                    str(final_backup),
                    str(temporary_checksum),
                    str(final_checksum),
                ]
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("refusing to overwrite existing backup artifact", result.stderr)
            self.assertEqual(final_backup.read_text(encoding="utf-8"), "existing-backup")
            self.assertEqual(
                final_checksum.read_text(encoding="utf-8"), "existing-checksum"
            )

        for script_name in ("backup.sh", "backup-attachments.sh"):
            text = (INFRA / "scripts" / script_name).read_text(encoding="utf-8")
            self.assertIn("new_backup_id", text)
            self.assertIn("publish_backup_pair", text)

    @requires_posix_shell
    def test_concurrent_backup_publication_has_exactly_one_winner(self) -> None:
        library = INFRA / "scripts" / "lib.sh"
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            final_backup = directory / "final.dump"
            final_checksum = directory / "final.dump.sha256"
            contenders: list[tuple[int, subprocess.Popen[str]]] = []

            for contender in range(16):
                temporary_backup = directory / f"backup-{contender}.partial"
                temporary_checksum = directory / f"checksum-{contender}.partial"
                temporary_backup.write_text(f"backup-{contender}", encoding="utf-8")
                temporary_checksum.write_text(f"checksum-{contender}", encoding="utf-8")
                process = subprocess.Popen(
                    [
                        "bash",
                        "-c",
                        (
                            'source "$1"; '
                            'publish_backup_pair "$2" "$3" "$4" "$5"; '
                            'printf "%s" "$6"'
                        ),
                        "bash",
                        str(library),
                        str(temporary_backup),
                        str(final_backup),
                        str(temporary_checksum),
                        str(final_checksum),
                        str(contender),
                    ],
                    cwd=ROOT,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                contenders.append((contender, process))

            outcomes = [
                (contender, process.returncode, stdout, stderr)
                for contender, process in contenders
                for stdout, stderr in [process.communicate(timeout=10)]
            ]
            winners = [outcome for outcome in outcomes if outcome[1] == 0]
            self.assertEqual(len(winners), 1, outcomes)
            winner = winners[0][0]
            self.assertEqual(final_backup.read_text(encoding="utf-8"), f"backup-{winner}")
            self.assertEqual(
                final_checksum.read_text(encoding="utf-8"), f"checksum-{winner}"
            )


    def test_backup_timer_units_exist_and_are_safe(self) -> None:
        unit_dir = INFRA / "systemd"
        service = (unit_dir / "project-operations-backup.service").read_text(encoding="utf-8")
        timer = (unit_dir / "project-operations-backup.timer").read_text(encoding="utf-8")
        wrapper = (unit_dir / "project-operations-backup").read_text(encoding="utf-8")

        # oneshot 备份不该被 systemd 自动重启，失败要看 Result 而不是被掩盖。
        self.assertIn("Requires=docker.service", service)
        self.assertIn("Type=oneshot", service)
        self.assertNotIn("Restart=", service)
        self.assertIn("UMask=0077", service)

        self.assertIn("Persistent=true", timer)
        self.assertIn("Australia/Melbourne", timer)
        self.assertIn("Unit=project-operations-backup.service", timer)

        # 失败要留证据、成功才写 SUCCESS、并且明确声明不是一致快照。
        self.assertIn("FAILED", wrapper)
        self.assertIn("SUCCESS", wrapper)
        self.assertIn("not-a-coordinated-snapshot", wrapper)
        self.assertIn("flock -n", wrapper)

    def test_backup_timer_installer_enables_only_after_a_successful_backup(self) -> None:
        installer = (INFRA / "scripts" / "install-backup-timer.sh").read_text(encoding="utf-8")

        # 路径必须走 drop-in：systemd 不继承调用者环境。
        self.assertIn("project-operations-backup.service.d", installer)
        self.assertNotIn("COMPOSE_FILE=\"$REPO/infra/compose.prod.yml\" ENV_FILE=\"$ENV_FILE\"", installer)
        # enable 必须排在首次备份之后。
        first_run = installer.index("systemctl start project-operations-backup.service")
        enable = installer.index("systemctl enable --now project-operations-backup.timer")
        self.assertLess(first_run, enable)


    def test_prune_backups_is_dry_run_by_default_and_protects_recent_data(self) -> None:
        script = (INFRA / "scripts" / "prune-backups.sh").read_text(encoding="utf-8")

        # 默认只演练：必须要有 --apply 才删。
        self.assertIn("--apply", script)
        self.assertIn("APPLY=0", script)
        # 三条保护：最近一次、最近一次 SUCCESS、最近 --keep-last 个。
        self.assertIn('keep+=("${sorted[-1]}")', script)
        self.assertIn('SUCCESS', script)
        self.assertIn("KEEP_LAST", script)
        # 只处理运行目录名，且不得在仓库内操作。
        self.assertIn("[0-9]{8}T[0-9]{6}Z-", script)
        self.assertIn("拒绝在仓库内操作", script)

    def test_prune_backups_keeps_the_newest_and_the_newest_success(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "scheduled"
            root.mkdir()
            # 四个成品（不同时间戳）+ 一个中断的半成品
            for index, name in enumerate(
                [
                    "20260101T000000Z-aaaaaa",
                    "20260102T000000Z-bbbbbb",
                    "20260103T000000Z-cccccc",
                    "20260104T000000Z-dddddd",
                ]
            ):
                # 注意：局部变量不能叫 run，会遮蔽模块级的 run() 辅助函数。
                run_dir = root / name
                run_dir.mkdir()
                (run_dir / "SUCCESS").write_text("status=SUCCESS\n", encoding="utf-8")
                # 全部做成"很旧"，只有最新一份是新的
                stamp = 1_700_000_000 + index * 86400
                os.utime(run_dir, (stamp, stamp))
            partial = root / "20260105T000000Z-eeeeee"
            partial.mkdir()
            os.utime(partial, (1_700_000_000, 1_700_000_000))

            result = run(
                [
                    "bash",
                    str(INFRA / "scripts" / "prune-backups.sh"),
                    "--backup-root",
                    str(root),
                    "--keep-days",
                    "0",
                    "--keep-last",
                    "1",
                    "--partial-days",
                    "0",
                    "--apply",
                ]
            )
            self.assertEqual(result.returncode, 0, result.stderr)

            remaining = sorted(path.name for path in root.iterdir())
            # 最新一次运行被保留（即使 keep-last=1 也一样）
            self.assertIn("20260105T000000Z-eeeeee", remaining)
            # 最近一次 SUCCESS 被保留
            self.assertIn("20260104T000000Z-dddddd", remaining)
            # 更旧的成品被删掉
            self.assertNotIn("20260101T000000Z-aaaaaa", remaining)
            self.assertNotIn("20260102T000000Z-bbbbbb", remaining)


    def test_restore_drill_never_touches_the_production_project(self) -> None:
        drill = (INFRA / "RESTORE-DRILL.md").read_text(encoding="utf-8")

        # 断言必须是会中止的助手，不能只是打印。
        self.assertIn("set -Eeuo pipefail", drill)
        self.assertIn("fail() { echo ", drill)
        self.assertIn("require_drill_project", drill)
        # 破坏性操作（restore / 附件整卷替换 / down --volumes）之前都要调用它。
        self.assertGreaterEqual(drill.count("require_drill_project"), 3)
        down_index = drill.index("down --volumes")
        self.assertLess(drill.rindex("require_drill_project", 0, down_index), down_index)
        # down 必须带全部 profile。
        self.assertIn("--profile application --profile tools --profile maintenance down --volumes", drill)
        # 不调用会写源库 schema 的 verify 脚本。
        self.assertIn("不调用会写 `infra_verify` schema", drill)

    def test_restore_scripts_accept_an_explicit_project_name(self) -> None:
        lib = (INFRA / "scripts" / "lib.sh").read_text(encoding="utf-8")
        attachments = (INFRA / "scripts" / "restore-attachments.sh").read_text(encoding="utf-8")
        drill = (INFRA / "RESTORE-DRILL.md").read_text(encoding="utf-8")

        # 公共选项里必须有 --project-name，并在 compose 调用上带 -p。
        self.assertIn("--project-name", lib)
        self.assertIn('COMPOSE_ARGS+=(--project-name "$PROJECT_NAME")', lib)
        # 附件整卷替换：没有显式项目名就拒绝，名字含 prod 也拒绝。
        self.assertIn("refusing to replace attachments without an explicit --project-name", attachments)
        self.assertIn("RESTORE_ALLOW_PRODUCTION", attachments)
        # 文档里必须真的把项目名传给这两个脚本。
        self.assertGreaterEqual(drill.count('--project-name "$DRILL_PROJECT"'), 2)

    def test_restore_drill_points_the_api_at_the_restored_database(self) -> None:
        drill = (INFRA / "RESTORE-DRILL.md").read_text(encoding="utf-8")

        # 只改 api 的连接库；postgres 的 POSTGRES_DB 必须保持不变。
        self.assertIn("POSTGRES_DB: project_operations_restore_verify", drill)
        self.assertIn("drill.override.yml", drill)
        # 必须显式核对 API 实际连的库，否则空的初始库也会报 database:up（假 PASS）。
        self.assertIn("假 PASS", drill)
        self.assertIn("POSTGRES_DB=project_operations_restore_verify", drill)
        # 健康检查走宿主端口，不依赖镜像内的 wget。
        self.assertIn("8081/api/v1/health", drill)
        # dump 已含 schema，不需要先迁移。
        self.assertIn("不需要先迁移一个空库", drill)

    def test_restore_drill_documents_real_script_output_and_timing_caveats(self) -> None:
        drill = (INFRA / "RESTORE-DRILL.md").read_text(encoding="utf-8")
        restore = (INFRA / "scripts" / "restore.sh").read_text(encoding="utf-8")

        # 文档里引用的输出必须与脚本一致：restore.sh 最后只打印目标库名。
        self.assertIn('"$target_database"', restore)
        self.assertIn("[infra] creating new restore target database: project_operations_restore_verify", drill)
        self.assertNotIn("restore target ready", drill)
        # 三段之和不是 RTO，且空库不可外推。
        self.assertIn("不是端到端 RTO", drill)
        self.assertIn("灾难确认", drill)
        self.assertIn("空库", drill)

    def test_seed_drill_data_refuses_non_drill_projects(self) -> None:
        script = (INFRA / "scripts" / "seed-drill-data.sh").read_text(encoding="utf-8")

        # 必须显式给项目名，且名字里要含 verify；否则拒绝写入。
        self.assertIn("拒绝在生产项目上灌数据", script)
        self.assertIn('"$PROJECT_NAME" == *verify*', script)
        # 合成数据只用于计时，必须一眼可辨、可清理。
        self.assertIn("drill.invalid", script)
        self.assertIn("seed_marker", script)
        # 工作日志从 DRAFT 起步，符合数据库守卫。
        self.assertIn("'DRAFT'", script)


    def test_offsite_copy_refuses_same_device_and_verifies_checksums(self) -> None:
        script = (INFRA / "scripts" / "backup-offsite.sh").read_text(encoding="utf-8")

        # 同一设备上的"副本"没有意义：必须比较设备号并拒绝。
        self.assertIn("stat -c %d", script)
        self.assertIn("这不算异机副本", script)
        # 复制后必须逐份校验；校验失败要删掉副本，不能留下假成功目录。
        self.assertIn("sha256sum --check", script)
        self.assertIn("校验失败，已删除副本", script)
        # 只带走已完成的运行，并把未完成的说清楚。
        self.assertIn("跳过未完成/失败的运行", script)
        # 外接盘会丢：支持加密。
        self.assertIn("--age-recipient", script)

    def test_offsite_installer_requires_a_real_mount_point(self) -> None:
        installer = (INFRA / "scripts" / "install-offsite-timer.sh").read_text(encoding="utf-8")

        # 没挂上外接盘时若悄悄复制到系统盘，等于没有副本：必须硬拒绝。
        self.assertIn("mountpoint -q", installer)
        self.assertIn("拒绝安装（否则会复制到系统盘）", installer)
        # 路径通过 drop-in 注入，而不是依赖调用者环境。
        self.assertIn("project-operations-offsite.service.d", installer)
        # 首次复制成功后才启用定时器。
        first_run = installer.index("systemctl start project-operations-offsite.service")
        enable = installer.index("systemctl enable --now project-operations-offsite.timer")
        self.assertLess(first_run, enable)

    def test_attachment_backup_artifacts_are_ignored_by_git(self) -> None:
        ignore_rules = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("project-operations-attachments-*.tar.gz", ignore_rules)
        self.assertIn("project-operations-attachments-*.tar.gz.sha256", ignore_rules)

    def test_python_quality_gate_dependency_is_documented(self) -> None:
        documentation = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("Python 3.11+", documentation)

    def test_network_inspection_uses_a_single_line_docker_template(self) -> None:
        script = INFRA / "scripts" / "verify-infrastructure.sh"
        text = script.read_text(encoding="utf-8")
        self.assertIn(
            "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}",
            text,
        )

    def test_real_verification_includes_attachment_backup_restore(self) -> None:
        script = (INFRA / "scripts" / "verify-infrastructure.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("verify-attachments.sh", script)

    def test_real_database_verification_checks_existing_target_refusal(self) -> None:
        script = (INFRA / "scripts" / "verify-backup-restore.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("existing_target_refusal=PASS", script)
        self.assertIn("restore unexpectedly replaced existing target", script)
        self.assertIn("restore failed for an unexpected reason", script)

    def test_database_verifier_cleans_only_owned_restore_target(self) -> None:
        script = (INFRA / "scripts" / "verify-backup-restore.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn('target_created="NO"', script)
        self.assertIn('if [[ "$target_created" == "YES" ]]', script)
        first_restore = script.index('"${SCRIPT_DIR}/restore.sh"')
        ownership = script.index('target_created="YES"')
        self.assertGreater(ownership, first_restore)

    def test_cleanup_includes_maintenance_profile_volumes(self) -> None:
        script = INFRA / "scripts" / "cleanup-verification.sh"
        self.assertTrue(script.is_file(), f"missing {script}")
        text = script.read_text(encoding="utf-8")
        self.assertIn(
            "compose --profile maintenance down --volumes --remove-orphans",
            text,
        )

    def test_destructive_verification_requires_disposable_project_name(self) -> None:
        destructive_scripts = (
            "verify-infrastructure.sh",
            "verify-persistence.sh",
            "verify-backup-restore.sh",
            "verify-attachments.sh",
            "cleanup-verification.sh",
        )
        for script_name in destructive_scripts:
            script = INFRA / "scripts" / script_name
            self.assertTrue(script.is_file(), f"missing {script}")
            self.assertIn(
                "require_disposable_project",
                script.read_text(encoding="utf-8"),
            )

    def test_psql_marker_substitution_reads_sql_from_standard_input(self) -> None:
        scripts = (
            INFRA / "scripts" / "verify-persistence.sh",
            INFRA / "scripts" / "verify-backup-restore.sh",
        )
        for script in scripts:
            text = script.read_text(encoding="utf-8")
            self.assertIn("<<'SQL'", text)
            marker_lines = [line for line in text.splitlines() if ":'marker'" in line]
            self.assertTrue(marker_lines, f"missing marker assertion in {script}")
            self.assertTrue(
                all("--command" not in line for line in marker_lines),
                "psql does not expand variables in the current --command path",
            )

    def test_caddy_routes_api_without_terminating_tls(self) -> None:
        caddyfile = INFRA / "Caddyfile"
        self.assertTrue(caddyfile.is_file(), f"missing {caddyfile}")
        text = caddyfile.read_text(encoding="utf-8")
        self.assertIn("auto_https off", text)
        self.assertIn("reverse_proxy api:3001", text)
        self.assertIn("reverse_proxy web:3000", text)
        self.assertNotIn("tls ", text)

    def test_caddy_format_is_clean_and_enforced_by_real_verification(self) -> None:
        caddyfile = (INFRA / "Caddyfile").read_text(encoding="utf-8")
        space_indented = [line for line in caddyfile.splitlines() if line.startswith("  ")]
        self.assertEqual(space_indented, [], "caddy fmt requires tab indentation")

        verification = (INFRA / "scripts" / "verify-infrastructure.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("caddy fmt --diff", verification)

    @requires_posix_shell
    def test_shell_scripts_are_syntactically_valid_and_help_without_docker(self) -> None:
        for script in SCRIPT_FILES:
            self.assertTrue(script.is_file(), f"missing {script}")
            syntax = run(["bash", "-n", str(script)])
            self.assertEqual(syntax.returncode, 0, syntax.stderr)

            env = os.environ.copy()
            env["PATH"] = "/usr/bin:/bin"
            help_result = run(["bash", str(script), "--help"], env=env)
            self.assertEqual(help_result.returncode, 0, help_result.stderr)
            self.assertIn("Usage:", help_result.stdout)

    def test_script_path_invocations_are_quoted(self) -> None:
        unquoted: list[str] = []
        for script in SCRIPT_FILES:
            for line_number, line in enumerate(
                script.read_text(encoding="utf-8").splitlines(), start=1
            ):
                if re.search(r'(?<!")\$\{SCRIPT_DIR\}/[^ ]+\.sh', line):
                    unquoted.append(f"{script.name}:{line_number}:{line}")
        self.assertEqual(unquoted, [])

    @requires_posix_shell
    def test_restore_rejects_unsafe_database_identifier_before_docker_access(self) -> None:
        script = INFRA / "scripts" / "restore.sh"
        self.assertTrue(script.is_file(), f"missing {script}")
        with tempfile.NamedTemporaryFile(suffix=".dump") as backup:
            env = os.environ.copy()
            env["PATH"] = "/usr/bin:/bin"
            result = run(["bash", str(script), backup.name, "unsafe-name"], env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("valid PostgreSQL identifier", result.stderr)

    @requires_posix_shell
    def test_checksum_sidecar_is_bound_to_selected_backup_file(self) -> None:
        library = INFRA / "scripts" / "lib.sh"
        with tempfile.TemporaryDirectory() as temp_dir:
            selected = Path(temp_dir) / "selected.dump"
            other = Path(temp_dir) / "other.dump"
            selected.write_bytes(b"selected-backup")
            other.write_bytes(b"different-backup")
            other_digest = hashlib.sha256(other.read_bytes()).hexdigest()
            Path(f"{selected}.sha256").write_text(
                f"{other_digest}  {other.name}\n",
                encoding="utf-8",
            )

            result = run(
                [
                    "bash",
                    "-c",
                    'source "$1"; verify_sha256_sidecar "$2"',
                    "bash",
                    str(library),
                    str(selected),
                ]
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match selected backup file", result.stderr)

    @requires_posix_shell
    def test_checksum_sidecar_is_required_and_well_formed(self) -> None:
        library = INFRA / "scripts" / "lib.sh"
        with tempfile.TemporaryDirectory() as temp_dir:
            selected = Path(temp_dir) / "selected.dump"
            selected.write_bytes(b"selected-backup")

            missing = run(
                [
                    "bash",
                    "-c",
                    'source "$1"; verify_sha256_sidecar "$2"',
                    "bash",
                    str(library),
                    str(selected),
                ]
            )
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn("checksum sidecar is required", missing.stderr)

            Path(f"{selected}.sha256").write_text("not-a-checksum\n", encoding="utf-8")
            malformed = run(
                [
                    "bash",
                    "-c",
                    'source "$1"; verify_sha256_sidecar "$2"',
                    "bash",
                    str(library),
                    str(selected),
                ]
            )
            self.assertNotEqual(malformed.returncode, 0)
            self.assertIn("malformed checksum sidecar", malformed.stderr)

    @requires_posix_shell
    def test_checksum_accepts_gnu_escaped_special_paths(self) -> None:
        library = INFRA / "scripts" / "lib.sh"
        with tempfile.TemporaryDirectory() as temp_dir:
            backup = Path(temp_dir) / "backup\\segment\nline.dump"
            backup.write_bytes(b"verified-special-path")
            sidecar = Path(f"{backup}.sha256")
            checksum_result = run(["sha256sum", str(backup)])
            self.assertEqual(checksum_result.returncode, 0, checksum_result.stderr)
            sidecar.write_text(checksum_result.stdout, encoding="utf-8")

            verification = run(
                [
                    "bash",
                    "-c",
                    'source "$1"; verify_sha256_sidecar "$2"',
                    "bash",
                    str(library),
                    str(backup),
                ]
            )
            self.assertEqual(verification.returncode, 0, verification.stderr)

        for script_name in ("backup.sh", "backup-attachments.sh"):
            text = (INFRA / "scripts" / script_name).read_text(encoding="utf-8")
            self.assertIn('sha256sum < "$temporary_path"', text)

    @requires_posix_shell
    def test_restore_uses_anonymous_verified_snapshot(self) -> None:
        library = INFRA / "scripts" / "lib.sh"
        with tempfile.TemporaryDirectory() as temp_dir:
            backup = Path(temp_dir) / "selected.dump"
            original = b"verified-snapshot-bytes"
            backup.write_bytes(original)
            digest = hashlib.sha256(original).hexdigest()
            Path(f"{backup}.sha256").write_text(
                f"{digest}  {backup.name}\n", encoding="utf-8"
            )

            snapshot_result = run(
                [
                    "bash",
                    "-c",
                    (
                        'source "$1"; '
                        "trap close_backup_snapshot EXIT; "
                        'open_verified_backup_snapshot "$2"; '
                        'printf changed > "$2"; '
                        'cat <&"$BACKUP_SNAPSHOT_FD"'
                    ),
                    "bash",
                    str(library),
                    str(backup),
                ]
            )
            self.assertEqual(snapshot_result.returncode, 0, snapshot_result.stderr)
            self.assertEqual(snapshot_result.stdout.encode(), original)

        for script_name in ("restore.sh", "restore-attachments.sh"):
            text = (INFRA / "scripts" / script_name).read_text(encoding="utf-8")
            self.assertIn('open_verified_backup_snapshot "$backup_file"', text)
            self.assertIn("BACKUP_SNAPSHOT_FD", text)
            self.assertNotIn('< "$backup_file"', text)
            self.assertNotIn("sha256sum --check", text)

    def test_database_restore_never_replaces_an_existing_target(self) -> None:
        text = (INFRA / "scripts" / "restore.sh").read_text(encoding="utf-8")
        before_restore = text.split("if ! compose exec --no-TTY postgres pg_restore", 1)[0]
        self.assertIn("refusing to replace existing target database", text)
        self.assertIn("target_exists=", text)
        self.assertNotIn("dropdb", before_restore)
        self.assertNotIn("ALLOW_PRIMARY_RESTORE", text)

    def test_database_restore_reports_cleanup_failure_truthfully(self) -> None:
        text = (INFRA / "scripts" / "restore.sh").read_text(encoding="utf-8")
        self.assertIn("restore failed and cleanup also failed", text)
        self.assertIn("partially restored database may remain", text)
        self.assertNotIn('"$target_database" || true', text)

    @requires_posix_shell
    def test_attachment_restore_rejects_unsafe_archive_members_before_docker(self) -> None:
        script = INFRA / "scripts" / "restore-attachments.sh"
        self.assertTrue(script.is_file(), f"missing {script}")

        with tempfile.TemporaryDirectory() as temp_dir:
            fixtures = {
                "traversal": ("../escape.txt", tarfile.REGTYPE, None),
                "symlink": ("unsafe-link", tarfile.SYMTYPE, "/etc/passwd"),
            }
            for name, (member_name, member_type, link_name) in fixtures.items():
                with self.subTest(name=name):
                    archive_path = Path(temp_dir) / f"{name}.tar.gz"
                    with tarfile.open(archive_path, "w:gz") as archive:
                        member = tarfile.TarInfo(member_name)
                        member.type = member_type
                        if link_name is not None:
                            member.linkname = link_name
                            archive.addfile(member)
                        else:
                            payload = b"unsafe-test"
                            member.size = len(payload)
                            archive.addfile(member, io.BytesIO(payload))

                    archive_digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
                    Path(f"{archive_path}.sha256").write_text(
                        f"{archive_digest}  {archive_path.name}\n",
                        encoding="utf-8",
                    )

                    env = os.environ.copy()
                    env["CONFIRM_ATTACHMENTS_RESTORE"] = "YES"
                    env["DOCKER_HOST"] = "unix:///definitely-not-present.sock"
                    result = run(["bash", str(script), str(archive_path)], env=env)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("unsafe attachment archive member", result.stderr)


if __name__ == "__main__":
    unittest.main()
