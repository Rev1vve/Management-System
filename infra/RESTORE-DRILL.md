# 恢复演练：逐条操作手册（在目标机上执行）

目的：证明"备份真的能变成一套可用系统"，并拿到 **RTO 基线**。
关键前提：**绝不在生产项目名下做**。下面每一步都有断言，不对就停。

---

## 0. 先做一次现成备份（如果没有最新的）

```bash
sudo systemctl start project-operations-backup.service
systemctl show project-operations-backup.service -p Result -p ExecMainStatus
```

预期：

```
Result=success
ExecMainStatus=0
```

确认产物存在（每次运行一个目录，里面是 dump + tar.gz + 两个 `.sha256`）：

```bash
sudo ls -1t /opt/project-operations/backups/scheduled | head -3
sudo ls -lh /opt/project-operations/backups/scheduled/<最近那个>/
```

预期 4 个文件：

```
project-operations-<ts>.dump
project-operations-<ts>.dump.sha256
project-operations-attachments-<ts>.tar.gz
project-operations-attachments-<ts>.tar.gz.sha256
```

> `restore.sh` 强制要求 `.sha256` sidecar 与 dump 同目录，缺了会直接 `die "checksum sidecar is required"`。

---

## 1. 准备演练环境文件（含镜像 tag，关键）

演练栈要和服务端**同一批镜像**，否则 `api-tools` 拉不到。镜像 tag 记录在 current 发布的 `release.env` 里：

```bash
COMPOSE=/srv/Management-System/infra/compose.prod.yml
DRILL_ENV=/opt/project-operations/shared/env/drill.env
DRILL_PROJECT=project-operations-verify

sudo install -m 640 -o root -g 10001 \
  /opt/project-operations/shared/env/prod.env "$DRILL_ENV"

# 追加覆盖（追加在文件末尾一定会生效，不依赖 sed 是否命中）
{
  printf 'COMPOSE_PROJECT_NAME=%s\n' "$DRILL_PROJECT"
  sudo cat /opt/project-operations/current/release.env
} | sudo tee -a "$DRILL_ENV" >/dev/null

sudo grep -E 'COMPOSE_PROJECT_NAME|API_IMAGE|WEB_IMAGE|API_TOOLS_IMAGE' "$DRILL_ENV"
```

预期最后四行类似：

```
COMPOSE_PROJECT_NAME=project-operations-verify
API_TOOLS_IMAGE=project-operations-api-tools:<sha>
API_IMAGE=project-operations-api:<sha>
WEB_IMAGE=project-operations-web:<sha>
```

> 如果 `current` 不存在或 `release.env` 缺失，先回看 `deploy.sh` 的输出——不要凭空猜 tag。

---

## 2. 断言项目名（**这一步不能跳**）

```bash
actual="$(sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" config --format json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
echo "实际项目名=$actual"
[ "$actual" = "$DRILL_PROJECT" ] || { echo "拒绝继续：项目名是 $actual"; exit 1; }
```

预期打印 `实际项目名=project-operations-verify`。

失败含义：env 覆盖没生效，此时 compose 会落回 `compose.prod.yml` 里的 `name:`，也就是**生产项目**。
继续下去会往生产库建库、甚至 `down --volumes` 删生产卷。**必须停下重做第 1 步。**

---

## 3. 起演练栈并跑迁移

```bash
sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" --profile tools run --rm api-tools pnpm db:migrate:deploy
```

预期最后一行：

```
✔ Generated Prisma Client ...
```

再确认演练栈的 postgres 起来了（用 `--profile tools` 是因为该栈只需要 db + tools，不需要 api/web/caddy）：

```bash
sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" --profile tools up -d postgres
sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" ps
```

预期看到 `project-operations-verify-postgres-1` 为 `Up ... (healthy)`。

> 演练栈有自己的卷（项目名前缀不同），与生产数据完全隔离。

---

## 4. 计时恢复（RTO 的核心数据）

```bash
RUN_DIR=$(sudo ls -1d /opt/project-operations/backups/scheduled/*/ | tail -1)
RUN_DIR="${RUN_DIR%/}"                       # 去掉尾斜杠，否则下面展开成空串
DUMP=$(sudo ls -1 "$RUN_DIR" | grep '\.dump$' | head -1)
echo "使用备份：$RUN_DIR/$DUMP"

time sudo /srv/Management-System/infra/scripts/restore.sh \
  --compose-file "$COMPOSE" --env-file "$DRILL_ENV" \
  "$RUN_DIR/$DUMP" \
  project_operations_restore_verify
```

预期结尾：

```
[infra] restored ... rows ...
```

`time` 会打印三行：

```
real    1m23.456s
user    0m0.123s
sys     0m0.045s
```

**记下 `real`**，这就是数据库侧的恢复耗时。注意它不是完整 RTO（还差"服务重新可用"的时间，见第 6 步）。

常见失败：

| 报错                                           | 原因                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `backup file not found`                        | 路径拼错（多半是尾斜杠问题），重新按上面取 `RUN_DIR`                               |
| `checksum sidecar is required`                 | 备份目录里缺 `.sha256`，说明那次备份没走完                                         |
| `refusing to replace existing target database` | 同名库已存在。换名字（如 `project_operations_restore_verify_2`）或先删掉演练栈的卷 |
| `not a valid PostgreSQL identifier`            | 库名必须 `^[a-z_][a-z0-9_]{0,62}$`                                                 |

---

## 5. 校验数据（对比生产只读计数）

演练栈里的计数：

```bash
sudo docker exec "${DRILL_PROJECT}-postgres-1" psql -U project_operations \
  -d project_operations_restore_verify \
  -c 'select (select count(*) from users) users, (select count(*) from projects) projects, (select count(*) from work_logs) work_logs;'
```

生产只读计数（**只读，不改任何东西**）：

```bash
sudo docker exec project-operations-center-prod-postgres-1 psql -U project_operations \
  -d project_operations \
  -c 'select (select count(*) from users) users, (select count(*) from projects) projects, (select count(*) from work_logs) work_logs;'
```

预期：**两组数字一致**（演练库是备份时刻的快照，若生产期间有新写入会有少量差异，允许演练 ≤ 生产）。

再抽查一条真实业务数据，确认不是"空表结构"：

```bash
sudo docker exec "${DRILL_PROJECT}-postgres-1" psql -U project_operations \
  -d project_operations_restore_verify \
  -c 'select number, name, status from projects order by created_at desc limit 5;'
```

---

## 6. 附件恢复（另一半数据）

附件在单独的卷里，不放回演练栈就没法说"系统可恢复"。

```bash
sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" --profile application up -d
TAR=$(sudo ls -1 "$RUN_DIR" | grep 'attachments.*\.tar\.gz$' | head -1)
time sudo env COMPOSE_FILE="$COMPOSE" ENV_FILE="$DRILL_ENV" CONFIRM_ATTACHMENTS_RESTORE=YES \
  /srv/Management-System/infra/scripts/restore-attachments.sh \
  --compose-file "$COMPOSE" --env-file "$DRILL_ENV" "$RUN_DIR/$TAR"
```

> `CONFIRM_ATTACHMENTS_RESTORE=YES` 是脚本的硬性要求：它替换整个附件卷。演练栈是独立卷，所以安全。

验证附件数量和体积：

```bash
sudo docker run --rm -v "${DRILL_PROJECT}_attachments_data:/data:ro" alpine:3.24.1 \
  sh -c 'du -sh /data; find /data -type f | wc -l'
```

与生产对比：

```bash
sudo docker run --rm -v project-operations-center-prod_attachments_data:/data:ro alpine:3.24.1 \
  sh -c 'du -sh /data; find /data -type f | wc -l'
```

预期：文件数一致（体积可略有差异）。

---

## 7. 端到端可用性（完整 RTO 的另一半）

演练栈的 Web/API 起来后，用不同端口验证（避免和生产 8080 冲突）：

```bash
sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" \
  --profile application ps
sudo docker exec "${DRILL_PROJECT}-api-1" wget -qO- --timeout=5 http://127.0.0.1:3001/api/v1/health
```

预期：

```json
{ "service": "project-operations-api", "status": "ok", "database": "up" }
```

**完整 RTO = 第 0 步备份耗时（可选）+ 第 4 步 restore `real` + 第 6 步附件恢复耗时 + 第 7 步服务可用时间。**

把四个数填进这张表存档：

| 项目                          | 耗时 |
| ----------------------------- | ---- |
| 数据库 restore（`real`）      |      |
| 附件 restore                  |      |
| 服务可用（启动到 health 200） |      |
| **合计 RTO**                  |      |

---

## 8. 清理（删之前再断言一次）

```bash
actual="$(sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" config --format json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
[ "$actual" = "$DRILL_PROJECT" ] || { echo "拒绝销毁：项目名是 $actual"; exit 1; }

sudo docker compose -f "$COMPOSE" --env-file "$DRILL_ENV" down --volumes
sudo rm -f "$DRILL_ENV"
sudo docker ps -a | grep -c verify || true
```

预期最后一条输出 `0`。

---

## 9. 三条铁律

1. **任何 `down --volumes` 之前必须打印项目名**，等于 `project-operations-center-prod` 一律停手。
2. **不要在演练里跑 `verify-backup-restore.sh`**：它要求项目名含 `verify`，而且会往源库写 `infra_verify` schema。演练请用本手册的 `restore.sh` 路线。
3. **迁移不随回滚**：演练栈跑的是当前版本的迁移；如果将来要回滚镜像，先确认旧镜像兼容当前表结构。

---

## 10. 演练记录模板（建议存进 `backups/drills/`）

```
日期：2026-11-__T__:__+11:00
备份来源：scheduled/<run-id>
镜像：api=<sha> tools=<sha>
数据库 restore（real）：___
附件 restore：___
服务可用：___
合计 RTO：___
计数对比：users ___/___ projects ___/___ work_logs ___/___
结论：PASS / FAIL
异常与处理：
```
