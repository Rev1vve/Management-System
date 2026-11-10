#!/usr/bin/env bash
set -Eeuo pipefail

# 安装失败告警：msmtp + systemd OnFailure。
#
# 关键点：安装过程会**真的发一封测试邮件**，发不出去就不算装好——
# 否则会留下"配置看起来对、实际永远发不出去"的静默告警。

Usage() {
  cat <<'USAGE'
Usage: install-alerting.sh (--webhook URL | --to ADDR --from ADDR --host SMTP_HOST) [options]

Wire scheduled-job failures to a notification channel.

通道一（推荐，最简单）：webhook 推送，不需要邮箱账号
  --webhook URL          推送地址（PushPlus / Server酱 / Bark）
  --webhook-kind KIND    pushplus（默认）| serverchan | bark

通道二：邮件
  --to ADDR          收件地址
  --from ADDR        发件地址
  --host SMTP_HOST   SMTP 服务器

Options:
  --port PORT            SMTP port (default: 587)
  --user USER            SMTP username (default: the --from address)
  --password-file FILE   File holding the SMTP password (mode 0600)
  --tls {on|off}         TLS mode for msmtp (default: on)
  --repo <path>          Repository checkout (default: the one containing this script)
  --skip-test-mail       Install without sending the test mail (not recommended)
  --dry-run              Print actions without changing the system
  --help                 Show this help

Example:
  sudo ./infra/scripts/install-alerting.sh \
    --to admin@example.com --from robot@example.com --host smtp.example.com
USAGE
}

log() { printf '[alerting] %s\n' "$*"; }
die() { printf '[alerting] 错误: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

TO=""
FROM=""
SMTP_HOST=""
WEBHOOK=""
WEBHOOK_KIND=pushplus
SMTP_PORT=587
SMTP_USER=""
PASSWORD_FILE=""
TLS_MODE=on
SKIP_TEST=0
DRY_RUN=0

while (($# > 0)); do
  case "$1" in
    --help|-h) Usage; exit 0 ;;
    --webhook) WEBHOOK="${2:?--webhook 需要 URL}"; shift 2 ;;
    --webhook-kind) WEBHOOK_KIND="${2:?--webhook-kind 需要类型}"; shift 2 ;;
    --to) TO="${2:?--to 需要地址}"; shift 2 ;;
    --from) FROM="${2:?--from 需要地址}"; shift 2 ;;
    --host) SMTP_HOST="${2:?--host 需要主机名}"; shift 2 ;;
    --port) SMTP_PORT="${2:?--port 需要端口}"; shift 2 ;;
    --user) SMTP_USER="${2:?--user 需要用户名}"; shift 2 ;;
    --password-file) PASSWORD_FILE="${2:?--password-file 需要路径}"; shift 2 ;;
    --tls) TLS_MODE="${2:?--tls 需要 on 或 off}"; shift 2 ;;
    --repo) REPO="${2:?--repo 需要路径}"; shift 2 ;;
    --skip-test-mail) SKIP_TEST=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "未知参数: $1" ;;
  esac
done

run() {
  if ((DRY_RUN)); then
    printf '[alerting][dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "需要 root：用 sudo 执行"
if [[ -z "$WEBHOOK" ]]; then
  [[ -n "$TO" && -n "$FROM" && -n "$SMTP_HOST" ]] || {
    Usage
    die "需要二选一：--webhook URL，或 --to/--from/--host（邮件）"
  }
fi
case "$WEBHOOK_KIND" in
  pushplus|serverchan|bark) ;;
  *) die "--webhook-kind 只支持 pushplus / serverchan / bark" ;;
esac
[[ -n "$SMTP_USER" ]] || SMTP_USER="$FROM"
[[ -n "$PASSWORD_FILE" ]] && [[ -f "$PASSWORD_FILE" ]] || true
if [[ -n "$PASSWORD_FILE" && -f "$PASSWORD_FILE" ]]; then
  mode="$(stat -c '%a' "$PASSWORD_FILE")"
  [[ "$mode" == "600" || "$mode" == "400" ]] || die "$PASSWORD_FILE 权限是 $mode，应为 600"
fi

if [[ -n "$WEBHOOK" ]]; then
  log "使用 webhook 通道（$WEBHOOK_KIND），不安装 msmtp"
elif ! command -v msmtp >/dev/null; then
  log "安装 msmtp"
  run apt-get update -qq
  run apt-get install -y --no-install-recommends msmtp
fi

# 配置放 /etc/msmtprc：root 专用，权限 0600。
if [[ -n "$WEBHOOK" ]]; then
  log "跳过 /etc/msmtprc（webhook 模式）"
elif ((DRY_RUN)); then
  log "dry-run：跳过写 /etc/msmtprc"
else
  {
    echo 'defaults'
    echo "auth           on"
    echo "tls            $TLS_MODE"
    echo "tls_trust_file /etc/ssl/certs/ca-certificates.crt"
    echo "logfile        ~/.msmtp.log"
    echo
    echo "account        project-operations"
    echo "host           $SMTP_HOST"
    echo "port           $SMTP_PORT"
    echo "from           $FROM"
    echo "user           $SMTP_USER"
    if [[ -n "$PASSWORD_FILE" ]]; then
      echo "passwordeval   cat $PASSWORD_FILE"
    fi
    echo
    echo "account default : project-operations"
  } > /etc/msmtprc
  chown root:root /etc/msmtprc
  chmod 0600 /etc/msmtprc
fi

run install -m 0750 -o root -g root \
  "$REPO/infra/systemd/project-operations-notify-failure" \
  /usr/local/sbin/project-operations-notify-failure
run install -m 0644 -o root -g root \
  "$REPO/infra/systemd/project-operations-alert@.service" \
  /etc/systemd/system/project-operations-alert@.service

# 收件人写进模板单元的 drop-in，避免把地址散落在各个 unit 里。
run install -d -m 0755 /etc/systemd/system/project-operations-alert@.service.d
if ((DRY_RUN)); then
  log "dry-run：跳过写告警 drop-in"
else
  {
    echo '[Service]'
    if [[ -n "$WEBHOOK" ]]; then
      echo "Environment=ALERT_WEBHOOK=$WEBHOOK"
      echo "Environment=ALERT_WEBHOOK_KIND=$WEBHOOK_KIND"
    else
      echo "Environment=ALERT_TO=$TO"
    fi
  } > /etc/systemd/system/project-operations-alert@.service.d/10-recipient.conf
  chmod 0644 /etc/systemd/system/project-operations-alert@.service.d/10-recipient.conf
fi

run systemctl daemon-reload

if ((SKIP_TEST)); then
  log "跳过测试邮件（不推荐：无法证明真的能发出去）"
elif ((DRY_RUN)); then
  log "dry-run：跳过测试邮件"
else
  log "发送测试告警到 ${WEBHOOK:-$TO}"
  if [[ -n "$WEBHOOK" ]]; then
    if ! ALERT_WEBHOOK="$WEBHOOK" ALERT_WEBHOOK_KIND="$WEBHOOK_KIND" \
      /usr/local/sbin/project-operations-notify-failure project-operations-selftest.service; then
      die "测试告警发送失败：请检查 webhook 地址与类型"
    fi
    log "测试告警已发送；请确认手机/微信确实收到（没收到就别认为装好了）"
  else
    if ! printf '这是一封来自 %s 的测试邮件。\n\n收到它说明备份失败告警链路可用。\n' \
      "$(hostname -f 2>/dev/null || hostname)" |
      msmtp --read-envelope-from --subject='[project-operations] 告警链路测试' "$TO"; then
      die "测试邮件发送失败：请检查 SMTP 主机/端口/凭据，或 --tls 设置"
    fi
    log "测试邮件已发送；请确认收件箱确实收到（没收到就别认为装好了）"
  fi
fi

cat <<'NEXT'
完成。剩下两件事要在目标机的两个 unit 上确认（本仓库已内置 OnFailure=）：
  systemctl show project-operations-backup.service -p OnFailure
  systemctl show project-operations-offsite.service -p OnFailure
预期分别指向 project-operations-alert@project-operations-backup.service 与 ...-offsite.service。
如果显示为空，说明机器上装的是旧版 unit：重新跑 install-backup-timer.sh / install-offsite-timer.sh。
NEXT
