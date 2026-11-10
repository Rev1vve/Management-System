# 恢复演练：逐条操作手册（在目标机上执行）

目的：证明"备份真的能变成一套可用系统"，并拿到**口径明确**的恢复耗时。
铁律：**绝不在生产项目名下做**。

下面所有片段都在同一个 shell 里执行，先起一个**会真正中止**的断言助手：

```bash
set -Eeuo pipefail
fail() { echo "断言失败：$*" >&2; exit 1; }
DRILL_PROJECT=project-operations-verify
require_drill_project() {
  local actual
  actual="$(sudo docker compose "${DC[@]}" config --format json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
  [ "$actual" = "$DRILL_PROJECT" ] || fail "项目名是 $actual，不是 $DRILL_PROJECT，已中止"
  echo "项目身份确认：$actual"
}
```

> 本手册已按 2026-11-11 的实际演练结果修订（空库演练 PASS）。13 条修正见文末"修订依据"。

---

## 0. 固定选一份"已验证"的备份

不要用通配符去展开 root 专属路径（普通用户 shell 展开会得到空列表）。先**看一眼**，再把目录名写死：

```bash
sudo ls -1t /opt/project-operations/backups/scheduled | head -5
```

挑一个带 `SUCCESS` 的，**手工复制它的名字**：

```bash
# 用实际目录名替换下面这行，不要用 $(ls ...) 展开
RUN_DIR=/opt/project-operations/backups/scheduled/20261110T140449Z-NAAJo7

sudo ls -l "$RUN_DIR"
```

预期五个文件（四个备份/校验 + 一个成功标记）：

```
project-operations-<ts>.dump
project-operations-<ts>.dump.sha256
project-operations-attachments-<ts>.tar.gz
project-operations-attachments-<ts>.tar.gz.sha256
SUCCESS
```

```bash
sudo test -f "$RUN_DIR/SUCCESS" && echo "SUCCESS 标记存在"
DUMP="$(sudo ls -1 "$RUN_DIR" | grep '\.dump$' | head -1)"
TAR="$(sudo ls -1 "$RUN_DIR" | grep 'attachments.*\.tar\.gz$' | head -1)"
echo "dump=$DUMP"; echo "tar=$TAR"
```

---

## 1. 准备演练配置（三个文件，缺一不可）

```bash
COMPOSE=/srv/Management-System/infra/compose.prod.yml
DRILL_ENV=/opt/project-operations/shared/env/drill.env
DRILL_OVERRIDE=/opt/project-operations/shared/env/drill.override.yml
RESTORE_DB=project_operations_restore_verify

# 1a) 基础 env：复制生产，再追加覆盖（追加一定生效，不依赖 sed 命中）
sudo install -m 640 -o root -g 10001 \
  /opt/project-operations/shared/env/prod.env "$DRILL_ENV"
{
  printf 'COMPOSE_PROJECT_NAME=%s\n' "$DRILL_PROJECT"
  printf 'APP_HTTP_PORT=8081\n'                     # 让开生产的 8080
  sudo cat /opt/project-operations/current/release.env
} | sudo tee -a "$DRILL_ENV" >/dev/null

# 1b) override：只把 API 的连接库指到恢复出来的库。
#     注意 postgres 服务的 POSTGRES_DB 必须保持 project_operations，
#     否则 postgres 初始化、restore.sh 的"源库"都会跟着变。
sudo tee "$DRILL_OVERRIDE" >/dev/null <<'YAML'
services:
  api:
    environment:
      POSTGRES_DB: project_operations_restore_verify
YAML
sudo chown root:10001 "$DRILL_OVERRIDE"
sudo chmod 0640 "$DRILL_OVERRIDE"
```

组合用的 compose 参数统一成：

```bash
DC=(docker compose -f "$COMPOSE" -f "$DRILL_OVERRIDE" --env-file "$DRILL_ENV" -p "$DRILL_PROJECT")
```

> `-p` 显式指定，不依赖 env 文件里的 `COMPOSE_PROJECT_NAME` 是否被正确读到。

---

## 2. 断言演练身份（四项，任一不符就停）

```bash
require_drill_project

echo "== 入口端口"; sudo docker compose "${DC[@]}" config --format json \
  | python3 -c 'import json,sys; p=json.load(sys.stdin)["services"]["caddy"]["ports"][0]; assert p["published"]=="8081" and p["host_ip"]=="127.0.0.1", p; print("ok", p)'

echo "== 卷归属"; sudo docker compose "${DC[@]}" config --format json \
  | python3 -c 'import json,sys; v=json.load(sys.stdin)["volumes"]; assert all((x or {}).get("external") is not True for x in v.values()), v; print("ok", list(v))'

echo "== 库名"; sudo docker compose "${DC[@]}" config --format json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["services"]; api=d["api"]["environment"]["POSTGRES_DB"]; pg=d["postgres"]["environment"]["POSTGRES_DB"]; assert api=="project_operations_restore_verify" and pg=="project_operations", (api,pg); print("ok api=",api,"postgres=",pg)'
```

预期三行都以 `ok` 开头：

```
项目身份确认：project-operations-verify
ok {'target': 8080, 'published': '8081', 'host_ip': '127.0.0.1', ...}
ok ['attachments_data', 'postgres_data']
ok api= project_operations_restore_verify postgres= project_operations
```

最后一行是最关键的一条：**API 连恢复库、postgres 仍指向 `project_operations`**（后者是 `restore.sh` 的"源库"）。

## 3. 只启动演练的 PostgreSQL

`pg_dump` 的 custom-format 里已包含 schema，**不需要先迁移一个空库**。

```bash
sudo "${DC[@]}" up -d postgres
sudo "${DC[@]}" ps
```

预期：`project-operations-verify-postgres-1` 为 `Up ... (healthy)`。

---

## 4. 计时恢复数据库（RTO 的第一段）

```bash
time sudo /srv/Management-System/infra/scripts/restore.sh \
  --compose-file "$COMPOSE" \
  --env-file "$DRILL_ENV" \
  --project-name "$DRILL_PROJECT" \
  "$RUN_DIR/$DUMP" \
  "$RESTORE_DB"
```

`restore.sh` 的真实输出是两行：先一条日志，最后**单独打印目标库名**（不是 "restored rows"）：

```
[infra] creating new restore target database: project_operations_restore_verify
project_operations_restore_verify
```

`--project-name` 是必须的：脚本本身不含 `-p`，只靠 env 文件插值时，一旦那行缺失就会落到生产项目去建库。

记下 `real` 秒数。

| 报错                                           | 原因                                             |
| ---------------------------------------------- | ------------------------------------------------ |
| `backup file not found`                        | `RUN_DIR` 写错（尾斜杠或用了通配符）             |
| `checksum sidecar is required`                 | 该备份目录缺 `.sha256`                           |
| `refusing to replace existing target database` | 演练库已存在：换名字，或先 `down --volumes` 重来 |

> `restore.sh` 用 `--env-file` 里的 `POSTGRES_DB` 作为"源库"来建目标库，所以这里**不能**把 `POSTGRES_DB` 改成恢复库名——override 文件只改 `api` 是刻意的。

---

## 5. 校验数据（对比生产只读计数）

```bash
sudo docker exec "${DRILL_PROJECT}-postgres-1" psql -U project_operations \
  -d "$RESTORE_DB" \
  -c 'select (select count(*) from users) users, (select count(*) from projects) projects, (select count(*) from work_logs) work_logs, (select count(*) from attachments) attachments;'

sudo docker exec project-operations-center-prod-postgres-1 psql -U project_operations \
  -d project_operations \
  -c 'select (select count(*) from users) users, (select count(*) from projects) projects, (select count(*) from work_logs) work_logs, (select count(*) from attachments) attachments;'
```

预期：两组数字一致（演练 ≤ 生产，差额是备份之后的新写入）。

**空库时这两行都是 0——这只能证明"流程能跑通"，不能证明"数据完整"。** 有真实业务数据后必须重跑。

---

## 6. 先恢复附件卷，再启动应用

```bash
time sudo env CONFIRM_ATTACHMENTS_RESTORE=YES \
  /srv/Management-System/infra/scripts/restore-attachments.sh \
  --compose-file "$COMPOSE" \
  --env-file "$DRILL_ENV" \
  --project-name "$DRILL_PROJECT" \
  "$RUN_DIR/$TAR"
```

脚本现在会**拒绝**没有显式项目名的调用，也会拒绝名字里含 `prod` 的项目（除非另设 `RESTORE_ALLOW_PRODUCTION=YES`）。这是整卷替换，不能靠"env 文件应该没问题"来担保。

预期输出含：

```
attachment_restore=PASS
```

核对文件数与字节数（演练 vs 生产，两边都只读挂载）：

```bash
for project in "$DRILL_PROJECT" project-operations-center-prod; do
  echo "== $project"
  sudo docker run --rm -v "${project}_attachments_data:/data:ro" alpine:3.24.1 \
    sh -c 'find /data -type f | wc -l; find /data -type f -exec sha256sum {} + | sort | sha256sum'
done
```

预期：两个项目的**文件数与摘要完全一致**。

---

## 7. 启动应用并通过 8081 验证

```bash
sudo "${DC[@]}" --profile application up -d

for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8081/api/v1/health || true)
  echo "try $i -> $code"
  # 启动瞬间可能出现 curl (56) Connection reset by peer：有界重试即可，不要当成失败
  [ "$code" = "200" ] && break
  sleep 2
done

curl -fsS http://127.0.0.1:8081/api/v1/health; echo
curl -fsS -o /dev/null -w 'login=%{http_code}\n' http://127.0.0.1:8081/login
```

预期：

```json
{"service":"project-operations-api","status":"ok","database":"up"}
login=200
```

**关键**：健康检查走宿主的 8081 入口，不要在 API 容器里 `wget`——镜像里可能没有这个命令。
另外确认 API 真的连到恢复库（不是空库）：

```bash
sudo docker inspect "${DRILL_PROJECT}-api-1" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^POSTGRES_(DB|HOST)='
```

预期：

```
POSTGRES_DB=project_operations_restore_verify
POSTGRES_HOST=postgres
```

> 若这里显示 `project_operations`，说明 override 没生效——那么上面那条 `database:up` 是**假 PASS**，必须停下修 override。

---

## 8. 清理（包含全部 profile，删前再断言）

```bash
require_drill_project        # 删之前必须再断言一次，失败即中止
sudo "${DC[@]}" --profile application --profile tools --profile maintenance down --volumes

# 再次确认演练资源已消失、生产仍在
sudo docker ps -a --format '{{.Names}}' | grep -c verify || true          # 期望 0
sudo docker volume ls --format '{{.Name}}' | grep -c verify || true       # 期望 0
curl -fsS http://127.0.0.1:8080/api/v1/health; echo                       # 生产仍 200

sudo rm -f "$DRILL_ENV" "$DRILL_OVERRIDE"
```

---

## 9. 耗时口径（别把三段之和叫 RTO）

| 阶段         | 本次实测    | 说明               |
| ------------ | ----------- | ------------------ |
| 数据库恢复   | 0.668 s     | 空库，仅供参考     |
| 附件恢复     | 0.279 s     | 空卷，仅供参考     |
| 启动到健康   | 3.021 s     | 镜像已在本地       |
| **三段合计** | **3.968 s** | **不是端到端 RTO** |

三段合计**不含**：发现故障、决定恢复、找备份、异机取回备份、建环境、数据库冷启动、人工操作间隔、业务功能验证。

**完整 RTO 应从"灾难确认"计时到"业务可用"，并且要在有真实数据量时测。**

---

## 10. 记录模板

```
日期：
备份来源：scheduled/<run-id>（含 SUCCESS）
镜像：api=<sha> web=<sha> tools=<sha>（附实际 image ID）
数据库恢复 real：___ s   目标库：project_operations_restore_verify
附件恢复：___ s          文件数/摘要一致：是/否
启动到健康：___ s        8081 health=200 login=200
计数对比：users __/__ projects __/__ work_logs __/__ attachments __/__
API 连接的库：project_operations_restore_verify（已 inspect 确认）
三段合计：___ s（不等于端到端 RTO）
端到端 RTO（灾难确认 → 业务可用）：___ s（需真实数据量）
结论：PASS / FAIL
异常：
```

---

## 11. 修订依据（2026-11-11 实际演练的 13 条修正）

1. 备份运行目录含 `SUCCESS`，正常是四文件 + 一个标记；
2. 固定使用已成功且已校验的目录，不用 shell 通配符展开 root 路径；
3. 演练 `APP_HTTP_PORT=8081`，仍绑 `127.0.0.1`；
4. compose 显式 `-p project-operations-verify`，恢复脚本显式传项目名；
5. 对项目名、卷名、external 标记、端口、回环绑定做断言；
6. 先只起演练 PostgreSQL；dump 已含 schema，无需先迁移；
7. `restore.sh` 的成功输出是目标库名，不是 "restored rows"；
8. 先初始化并恢复附件卷，再启动应用；
9. 需要 `drill.override.yml` 只覆盖 `api.environment.POSTGRES_DB`，否则 API 连的是空库；
10. 健康检查走宿主 8081，不依赖 API 镜像里的 `wget`；
11. 启动瞬间的 `curl (56) Connection reset` 属正常，用有界重试；
12. 不调用会写 `infra_verify` schema 的 `verify-backup-restore.sh`；
13. 清理时带上 application/tools/maintenance 全部 profile，并复核项目与卷归属。
