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

## 开发基础设施

基础设施准备、密钥文件、静态验证和一次性容器验收步骤见：

- [`infra/README.md`](infra/README.md)

PostgreSQL 不映射宿主机端口；开发邮件捕获器和生产反向代理只绑定宿主机 loopback。任何 secret 值都不进入 Git。数据库与附件分别备份并校验；生产数据启用前仍须建立同一恢复点与加密异机副本。
