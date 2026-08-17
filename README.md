# 项目运营中心

面向内部团队的项目运营管理平台。网站与未来手机 App 只通过版本化 API 访问业务数据，不直接连接 PostgreSQL。

## 当前阶段

任务 1：monorepo、Next.js/NestJS 最小骨架与质量门禁。此阶段不包含数据库、Docker Compose 或生产部署。

## 环境要求

- Node.js 22.13 或更高版本
- Corepack

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
