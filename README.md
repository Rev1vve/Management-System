# 项目运营中心

面向内部团队的项目运营管理平台。网站与未来手机 App 只通过版本化 API 访问业务数据，不直接连接 PostgreSQL。

## 当前阶段

任务 2：在任务 1 的 monorepo 与质量门禁基础上，建立 Docker Compose、Caddy、PostgreSQL 私有网络以及备份/恢复验证脚本。尚未包含 Prisma 业务模型或生产部署。

## 环境要求

- Node.js 22.13 或更高版本
- Python 3.11+（基础设施契约与安全测试）
- Corepack
- Docker Engine 29 或兼容版本
- Docker Compose 2.40 或兼容版本

## 安装

```bash
corepack pnpm@11.22.0 install
```

## 开发

```bash
corepack pnpm@11.22.0 dev
```

- Web: http://localhost:3000
- API: http://localhost:3001/api/v1

## 质量门禁

```bash
corepack pnpm@11.22.0 format:check
corepack pnpm@11.22.0 lint
corepack pnpm@11.22.0 typecheck
corepack pnpm@11.22.0 test
corepack pnpm@11.22.0 build
corepack pnpm@11.22.0 quality
```

所有命令必须通过，CI 才允许进入后续阶段。

## Windows 本机开发（无 Docker）

本仓库同时支持 Linux（CI 与生产）与 Windows（本机开发/验收）。Windows 上没有 Docker 时：

```bash
# 一次性 PostgreSQL 18.6（与 compose 的 postgres:18.6 对齐），自动迁移 + seed + 跑集成测试
pnpm db:local pnpm --filter @project-operations/api test:integration

# 只启动数据库并保持运行（另开终端可连 127.0.0.1:55432，账号 postgres/postgres）
pnpm db:local:hold
```

- 数据目录 `.hermes/local-pg/`（已被 Git 忽略），端口默认 55432，可用 `LOCAL_PG_PORT` 覆盖。
- 附件存储层是双实现：Linux 走 `/proc/self/fd` 句柄锚定 + 0700/0600 + `mv -nT`；
  Windows 走 NTFS ACL **白名单校验** + 路径归一 + `link()`/`unlink()` 无覆盖语义。见
  [`apps/api/src/modules/attachments/storage-platform.ts`](apps/api/src/modules/attachments/storage-platform.ts)。

### Windows 附件根目录的私有性要求

Windows 没有 0700/0600 语义，私有性由 NTFS ACL 承担。服务在启动和每次目录遍历时**只校验、不改写** ACL：

- 目录/文件 ACL 中的每一条 `Allow` 主体必须是以下之一：**运行服务的账号 SID**、`SYSTEM`、
  `Administrators`；其余一律拒绝（`附件目录 ACL 未收紧`）。
- `Everyone` / `Users` / `Authenticated Users` / `INTERACTIVE` / `ANONYMOUS` / `Guests`
  **无条件拒绝**，即使写进扩展白名单也不放行；`Deny` 条目只收紧权限，忽略。
- 因此 `ATTACHMENTS_ROOT` 要放在"只有服务账号可读写"的位置（例如
  `%ProgramData%\项目运营中心\attachments` 或该账号的私有目录），不要放在 `公共`、`桌面共享`
  或对 `Users` 开放磁盘根目录下。
- 受限令牌环境（部分 CI 沙箱）如需运行附件测试，可设置
  `ATTACHMENTS_ACL_ALLOWED_SIDS=S-1-5-21-...,S-1-5-21-...` 显式追加可信主体；
  **默认为空**，生产不要设置该变量。
- `pnpm infra:check` 在 Windows 上会跳过 12 项：11 项依赖 POSIX shell/`coreutils`/Docker 的契约
  （显式标记原因，由 `ubuntu-latest` CI 覆盖）+ 1 项只约束 Linux CI 的工具链反向断言。

## 开发基础设施

基础设施准备、密钥文件、静态验证和一次性容器验收步骤见：

- [`infra/README.md`](infra/README.md)

PostgreSQL 不映射宿主机端口；开发邮件捕获器和生产反向代理只绑定宿主机 loopback。任何 secret 值都不进入 Git。数据库与附件分别备份并校验；生产数据启用前仍须建立同一恢复点与加密异机副本。
