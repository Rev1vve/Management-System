from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
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
    INFRA / "env" / "dev.env.example",
    INFRA / "env" / "prod.env.example",
    INFRA / "secrets" / ".gitignore",
    INFRA / "scripts" / "backup.sh",
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


class InfrastructureContractTests(unittest.TestCase):
    def test_expected_task_two_files_exist(self) -> None:
        missing = [str(path.relative_to(ROOT)) for path in EXPECTED_FILES if not path.is_file()]
        self.assertEqual(missing, [], f"missing task 2 files: {missing}")

    def test_compose_configs_render_with_private_database_network(self) -> None:
        self.assertIsNotNone(shutil.which("docker"), "docker CLI is required for Compose validation")

        with tempfile.TemporaryDirectory() as temp_dir:
            secret_path = Path(temp_dir) / "postgres-password"
            secret_path.write_text("contract-test-only\n", encoding="utf-8")
            env = os.environ.copy()
            env.update(
                {
                    "POSTGRES_PASSWORD_FILE": str(secret_path),
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
                volume_sources = {volume["source"] for volume in maintenance["volumes"]}
                self.assertIn("attachments_data", volume_sources)
                self.assertIn("attachments_data", config["volumes"])

                if compose_file.name == "compose.dev.yml":
                    mailpit = config["services"]["mailpit"]
                    self.assertRegex(mailpit["image"], r"@sha256:[0-9a-f]{64}$")
                    for port in mailpit.get("ports", []):
                        self.assertEqual(port.get("host_ip"), "127.0.0.1")
                else:
                    caddy = config["services"]["caddy"]
                    self.assertRegex(caddy["image"], r"@sha256:[0-9a-f]{64}$")
                    self.assertTrue(caddy.get("ports"), "production reverse proxy needs a loopback port")
                    for port in caddy["ports"]:
                        self.assertEqual(port.get("host_ip"), "127.0.0.1")

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

    def test_restore_rejects_unsafe_database_identifier_before_docker_access(self) -> None:
        script = INFRA / "scripts" / "restore.sh"
        self.assertTrue(script.is_file(), f"missing {script}")
        with tempfile.NamedTemporaryFile(suffix=".dump") as backup:
            env = os.environ.copy()
            env["PATH"] = "/usr/bin:/bin"
            result = run(["bash", str(script), backup.name, "unsafe-name"], env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("valid PostgreSQL identifier", result.stderr)

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
