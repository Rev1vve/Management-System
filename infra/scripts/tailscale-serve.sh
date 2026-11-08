#!/usr/bin/env bash
set -Eeuo pipefail

# 任务 13：在目标机上把生产入口通过 Tailscale 私网暴露为 HTTPS。
#
# 拓扑（与 MASTER_PLAN §3 一致）：
#   设备 --(tailnet, TLS)--> tailscaled --(本机回环)--> Caddy :8080 --> api/web
# 因此：不开公网端口、不做端口转发、5432 不映射到宿主机、不使用 Funnel。
#
# 前置：tailnet 里需开启 HTTPS Certificates 与 MagicDNS，否则 serve 拿不到证书。

Usage() {
  cat <<'USAGE'
Usage: tailscale-serve.sh [options]

Install Tailscale and publish the local Caddy (127.0.0.1:PORT) over the tailnet.

Options:
  --port <port>        Caddy port on this host (default: 8080)
  --hostname <name>    Hostname inside the tailnet (default: system hostname)
  --check              Verify the configuration only (exit non-zero when unsafe)
  --dry-run            Print the commands instead of running them
  --help               Show this help

Example:
  sudo ./infra/scripts/tailscale-serve.sh --hostname project-operations
USAGE
}

log() { printf '[tailscale] %s\n' "$*"; }
die() { printf '[tailscale] 错误: %s\n' "$*" >&2; exit 1; }

PORT=8080
HOSTNAME_ARG=""
CHECK_ONLY=0
DRY_RUN=0

while (($# > 0)); do
  case "$1" in
    --help|-h) Usage; exit 0 ;;
    --port) PORT="${2:?--port 需要端口}"; shift 2 ;;
    --hostname) HOSTNAME_ARG="${2:?--hostname 需要名称}"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "未知参数: $1" ;;
  esac
done

run() {
  if ((DRY_RUN)); then
    printf '[tailscale][dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# fail-closed 检查：任何一条不满足都返回非零，而不是打印"通过"。
check() {
  command -v tailscale >/dev/null || die "Tailscale 未安装"
  tailscale status >/dev/null 2>&1 || die "Tailscale 未登录 tailnet"

  # 1) 5432 不得出现在宿主监听列表
  if ss -ltn 2>/dev/null | grep -qE '[:.]5432[[:space:]]'; then
    die "5432 出现在宿主机监听列表：数据库被暴露"
  fi

  # 2) Caddy 只绑定回环：必须能看到 127.0.0.1:PORT，且不得看到 0.0.0.0/:: 的同一端口
  ss -ltn 2>/dev/null | grep -qE "127\.0\.0\.1:${PORT}[[:space:]]" ||
    die "未发现 127.0.0.1:${PORT} 监听（Caddy 没起来？）"
  if ss -ltn 2>/dev/null | grep -qE "(0\.0\.0\.0|\[::\]):${PORT}[[:space:]]"; then
    die "端口 ${PORT} 绑定到了非回环地址：入口被暴露"
  fi

  # 3) serve 配置必须指向本机回环，且不能是 Funnel（公网）
  local serve_status
  serve_status="$(tailscale serve status 2>/dev/null || true)"
  grep -q "127.0.0.1:${PORT}" <<<"$serve_status" || die "tailscale serve 未指向 127.0.0.1:${PORT}"
  if tailscale funnel status 2>/dev/null | grep -qi "funnel"; then
    die "检测到 Funnel：会把服务暴露到公网，请关闭"
  fi

  # 4) 打印 tailnet URL 供人工验证"非 tailnet 不可访问"
  local dns
  dns="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  log "tailnet 入口：https://${dns%.}"
  log "检查通过：入口仅回环、数据库未暴露、未启用 Funnel"
  log "仍需人工确认：非 tailnet 设备访问上面的地址应超时"
}

if ((CHECK_ONLY)); then
  check
  exit 0
fi

command -v curl >/dev/null || die "缺少 curl"

if ! command -v tailscale >/dev/null; then
  log "安装 Tailscale（官方脚本）"
  installer="$(mktemp)"
  # 用 mktemp 拿唯一文件名再执行，避免固定 /tmp 路径的符号链接与 TOCTOU 风险。
  run curl -fsSL https://tailscale.com/install.sh -o "$installer"
  run sh "$installer"
  rm -f "$installer"
fi

if ! tailscale status >/dev/null 2>&1; then
  log "登录 tailnet：按输出的链接完成授权"
  if [[ -n "$HOSTNAME_ARG" ]]; then
    run tailscale up --hostname "$HOSTNAME_ARG"
  else
    run tailscale up
  fi
fi

# serve 只做本机反代；Funnel 才会暴露到公网，这里明确不使用。
log "配置 tailscale serve → 127.0.0.1:${PORT}"
run tailscale serve --bg --yes "http://127.0.0.1:${PORT}"

if ((DRY_RUN)); then
  log "dry-run 结束"
  exit 0
fi

check
