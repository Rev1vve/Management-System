# 任务 13：生产部署检查单（Ubuntu 24.04 / x86_64）

目标机 = 原迁移来源那台 Ubuntu。已确认：`x86_64`、`Ubuntu 24.04`、Tailscale 未安装、2 TB 磁盘。
部署根目录取 `/opt/project-operations`（脚本可用 `--deploy-root` 覆盖）。

镜像按提交号打 tag（`project-operations-{api,web,api-tools}:<sha>`），回滚才有意义。

## 0. 前置

- [ ] `uname -m` = `x86_64`，`lsb_release -rs` = `24.04`
- [ ] `docker --version` ≥ 27，`docker compose version` 为 v2
- [ ] `sudo` 可用；能访问 Docker Hub 与 Ubuntu 源
- [ ] 磁盘：`/opt/project-operations` 与备份同盘时，给 `backups/` 单独限额（建议 ≥ 200 GB）
- [ ] tailnet 已开启 **HTTPS Certificates** 与 **MagicDNS**（否则 `tailscale serve` 拿不到证书）

## 1. 目录与密钥（用 root 一次性创建，避免普通用户重定向把 mode 改坏）

```bash
sudo install -d -m 755 /opt/project-operations/{releases,shared/env,shared/secrets}
sudo install -d -m 700 /opt/project-operations/backups

sudo sh -c 'umask 077; openssl rand -base64 48 > /opt/project-operations/shared/secrets/postgres-password.txt'
sudo sh -c 'umask 077; openssl rand -hex 32  > /opt/project-operations/shared/secrets/mfa-secret-key.txt'
sudo chown root:10001 /opt/project-operations/shared/secrets/*.txt
sudo chmod 0440 /opt/project-operations/shared/secrets/*.txt
```

- [ ] `stat -c '%U:%g:%a' .../postgres-password.txt` = `root:10001:440`
- [ ] 同上，`mfa-secret-key.txt` 也是 `root:10001:440`
- [ ] `/opt/project-operations/shared/env/prod.env` 由 `infra/env/prod.env.example` 复制而来，
      `POSTGRES_PASSWORD_FILE` / `MFA_SECRET_KEY_FILE` 指向上面两个绝对路径

## 2. 部署

```bash
sudo git clone https://github.com/Rev1vve/Management-System.git /srv/Management-System
sudo /srv/Management-System/infra/scripts/deploy.sh --source /srv/Management-System --dry-run
sudo /srv/Management-System/infra/scripts/deploy.sh --source /srv/Management-System
```

脚本依次：校验密钥 → 构建 `api/web/api-tools:<sha>` → `--profile tools run --rm api-tools pnpm db:migrate:deploy`
→ `--profile application up -d` → 等 `/api/v1/health` 与 `/login` 都 200 → 写 `releases/<sha>/release.env` 并切换 `current`。

- [ ] 输出 `部署完成`；`current` 指向本次 sha
- [ ] `curl -fsS http://127.0.0.1:8080/api/v1/health` 返回 `{"status":"ok","database":"up"}`

## 3. Tailscale 私网入口

```bash
sudo /srv/Management-System/infra/scripts/tailscale-serve.sh --hostname project-operations
sudo /srv/Management-System/infra/scripts/tailscale-serve.sh --check
```

`--check` 是 fail-closed 的：5432 出现在宿主监听、入口绑到非回环、或检测到 Funnel 都会返回非零。

## 4. 验收（任务 13 四条硬指标）

- [ ] **非 tailnet 不可访问**：外部设备访问 `https://project-operations.<tailnet>.ts.net` 超时；同 tailnet 设备能打开登录页
- [ ] **5432 未暴露**：`ss -ltn | grep 5432` 无输出；`docker compose --profile application ps` 中 postgres 无 published port
- [ ] **重启自恢复**：`sudo reboot` 后 3 分钟内 `/api/v1/health` 回到 200，`tailscale serve status` 仍有配置
- [ ] **恢复演练**：见下一节

## 5. 备份与恢复演练（备份脚本要用生产编排与环境文件）

```bash
COMPOSE_FILE=/srv/Management-System/infra/compose.prod.yml
ENV_FILE=/opt/project-operations/shared/env/prod.env

sudo env COMPOSE_FILE=$COMPOSE_FILE ENV_FILE=$ENV_FILE \
  /srv/Management-System/infra/scripts/backup.sh --backup-dir /opt/project-operations/backups
sudo env COMPOSE_FILE=$COMPOSE_FILE ENV_FILE=$ENV_FILE \
  /srv/Management-System/infra/scripts/backup-attachments.sh --backup-dir /opt/project-operations/backups
sudo env COMPOSE_FILE=$COMPOSE_FILE ENV_FILE=$ENV_FILE \
  /srv/Management-System/infra/scripts/verify-backup-restore.sh --backup-dir /opt/project-operations/backups
```

- [ ] 演练输出 PASS，临时库已清理
- [ ] 记录耗时（RTO 依据）：`time sudo env ... verify-backup-restore.sh ...`

## 6. 回滚

```bash
sudo /srv/Management-System/infra/scripts/rollback.sh --deploy-root /opt/project-operations
```

回滚会用上一份 `release.env` 的镜像 tag 重新 `up -d`，并在健康检查通过后才切换 `current`。

- [ ] 回滚后 `/api/v1/health` 为 200
- [ ] **数据库迁移不随回滚**：跨版本回滚前先确认迁移向后兼容

## 7. 遗留

- [ ] 旧机证据拷贝（Q-103）：旧库/日志留存到 `backups/legacy-<date>/`
- [ ] 备份用 systemd timer 定时跑；先人工跑两周再谈自动化告警
- [ ] 镜像扫描（Trivy/Grype，任务 12 遗留）：CI 里 build 之后加一步扫描
