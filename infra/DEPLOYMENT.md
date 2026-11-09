# 任务 13：生产部署检查单（Ubuntu 26.04 / x86_64）

目标机 = 原迁移来源那台 Ubuntu。实测：`x86_64`、`Ubuntu 26.04`、Docker 29.1.3、Compose 2.40.3、
根分区 1.9 TB（可用 1.6 TB）、Tailscale 未安装。
部署根目录取 `/opt/project-operations`（脚本可用 `--deploy-root` 覆盖）。

镜像按提交号打 tag（`project-operations-{api,web,api-tools}:<sha>`），回滚才有意义。

## 0. 前置

- [ ] `uname -m` = `x86_64`；`lsb_release -rs` 记下来（当前 26.04）
- [ ] `docker --version` ≥ 27（当前 29.1.3），`docker compose version` 为 v2（当前 2.40.3）
- [ ] `sudo` 可用；能访问 Docker Hub 与 Ubuntu 源
- [ ] 磁盘：根分区 1.9 TB、可用 1.6 TB，`backups/` 建议单独限额 ≥ 200 GB
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

## 5. 备份与恢复演练

### 5.1 备份（生产编排 + 生产 env）

```bash
COMPOSE_FILE=/srv/Management-System/infra/compose.prod.yml
ENV_FILE=/opt/project-operations/shared/env/prod.env

sudo env COMPOSE_FILE=$COMPOSE_FILE ENV_FILE=$ENV_FILE \
  /srv/Management-System/infra/scripts/backup.sh --backup-dir /opt/project-operations/backups
sudo env COMPOSE_FILE=$COMPOSE_FILE ENV_FILE=$ENV_FILE \
  /srv/Management-System/infra/scripts/backup-attachments.sh --backup-dir /opt/project-operations/backups
```

定时备份由 systemd 负责（`project-operations-backup.timer`，每天 03:00 Australia/Melbourne，
`Persistent=true`，产物在 `backups/scheduled/<UTC>-<随机>/`，两份 `.sha256` 校验通过才写 `SUCCESS`）。
源码在 `infra/systemd/`，安装脚本 `infra/scripts/install-backup-timer.sh`。

```bash
systemctl list-timers project-operations-backup.timer --all --no-pager
systemctl show project-operations-backup.service -p Result -p ExecMainStatus
sudo journalctl -u project-operations-backup.service -n 50 --no-pager
```

### 5.1b 清理旧备份（先演练，再真删）

```bash
# 演练：只看会删什么，不动文件（默认就是 dry-run）
sudo /srv/Management-System/infra/scripts/prune-backups.sh \
  --backup-root /opt/project-operations/backups/scheduled \
  --keep-days 14 --keep-last 3

# 确认无误后真删
sudo /srv/Management-System/infra/scripts/prune-backups.sh \
  --backup-root /opt/project-operations/backups/scheduled \
  --keep-days 14 --keep-last 3 --apply
```

安全规则（脚本里硬编码，不要绕过）：

- **永远保留最近一次运行**，哪怕它很旧；**永远保留最近一次成功（SUCCESS）运行**——备份连续失败时，最后一份好数据不会被当成"旧的"删掉；
- 只处理名字形如 `<UTC时间戳>-<后缀>` 的运行目录，其余文件一律不碰；
- 没有 `SUCCESS`/`FAILED` 标记的中断目录，只有超过 `--partial-days`（默认 2）天才清理；
- 备份根位于仓库内时直接拒绝；
- 年龄按**目录名里的时间戳**算，不看 mtime（拷贝/恢复会改 mtime）。

- [ ] 演练输出里"保护名单"包含最近一次与最近一次 SUCCESS
- [ ] `--apply` 后 `sudo ls -1 /opt/project-operations/backups/scheduled | wc -l` 数量符合预期
- [ ] 定期看一眼磁盘：`df -h /` 与 `sudo du -sh /opt/project-operations/backups`

### 5.2 恢复演练：**不要在生产和生产项目名下做**

`verify-backup-restore.sh` 有两道硬约束，别去绕：

1. `require_disposable_project` 要求 Compose 项目名包含 `verify`，生产项目名会被直接拒绝；
2. 它会往**源库**写一个 `infra_verify` schema 再逐级清理，所以它压根不是"完全不动源库"。

生产数据的恢复演练要另起一套一次性栈，把生产备份**恢复到那里**。项目名必须是显式的验证名，
并且每一步之前都断言它——`prod.env` 是手工维护的，靠 sed 改名一旦没命中就会落回生产项目名。

```bash
COMPOSE=/srv/Management-System/infra/compose.prod.yml
DRILL_ENV=/opt/project-operations/shared/env/drill.env
DRILL_PROJECT=project-operations-verify

# 1) 生成演练 env：先复制，再"追加"覆盖值（追加在文件末尾，一定生效；不依赖 sed 命中）
sudo install -m 640 -o root -g 10001 /opt/project-operations/shared/env/prod.env "$DRILL_ENV"
printf 'COMPOSE_PROJECT_NAME=%s\n' "$DRILL_PROJECT" | sudo tee -a "$DRILL_ENV" >/dev/null

# 2) 断言项目名就是验证项目；不是就停下，绝不继续
actual="$(sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" config --format json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
[ "$actual" = "$DRILL_PROJECT" ] || { echo "拒绝继续：项目名是 $actual"; exit 1; }

# 3) 取最新一次定时备份（去掉尾斜杠后再取样例名，避免展开成空串）
RUN_DIR=$(sudo ls -1d /opt/project-operations/backups/scheduled/*/ | tail -1)
RUN_DIR="${RUN_DIR%/}"
DUMP=$(sudo ls -1 "$RUN_DIR" | grep '\.dump$' | head -1)
[ -n "$DUMP" ] || { echo "该目录没有 dump：$RUN_DIR"; exit 1; }

# 4) 一次性栈跑迁移（只影响验证项目自己的卷）
sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" --profile tools \
  run --rm api-tools pnpm db:migrate:deploy

# 5) 计时：把生产 dump 恢复到这套一次性栈
time sudo /srv/Management-System/infra/scripts/restore.sh \
  --compose-file "$COMPOSE" --env-file "$DRILL_ENV" \
  "$RUN_DIR/$DUMP" \
  project_operations_restore_verify

# 6) 校验关键计数（对照生产只读计数）
sudo docker exec "${DRILL_PROJECT}-postgres-1" psql -U project_operations -d project_operations_restore_verify \
  -c 'select (select count(*) from users) as users, (select count(*) from projects) as projects, (select count(*) from work_logs) as work_logs;'

# 7) 清理：删之前再断言一次项目名
actual="$(sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" config --format json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
[ "$actual" = "$DRILL_PROJECT" ] || { echo "拒绝销毁：项目名是 $actual"; exit 1; }
sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" down --volumes
sudo rm -f "$DRILL_ENV"
```

- [ ] 第 2、7 步的断言都打印出 `project-operations-verify`，没有出现生产项目名
- [ ] 第 5 步有真实耗时（这才是 RTO 数据；备份耗时不是）
- [ ] 第 6 步计数与生产一致
- [ ] 第 7 步后 `docker ps -a | grep verify` 无残留
- [ ] **绝不**对生产项目执行 `docker compose down --volumes`

> 注：`infra/tests` 的契约测试与开发栈仍用 `verify-backup-restore.sh`（项目名含 verify），那里可以放心跑。

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
