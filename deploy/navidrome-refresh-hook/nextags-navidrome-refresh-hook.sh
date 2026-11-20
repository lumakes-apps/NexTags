#!/usr/bin/env bash
set -euo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

LOG_FILE="/var/log/nextags-navidrome-refresh-hook.log"
REQUEST_FILE="/var/lib/docker/volumes/nextags_app-data/_data/navidrome_refresh/request.json"
LOCK_FILE="/run/nextags-navidrome-refresh-hook.lock"
# 掃描結束後寫入的狀態檔，NexTags 據此判斷「標籤修改已被 Navidrome 掃描」，才搬移檔案。
# 必須放在 navidrome_refresh/ 以外：.path unit 監看該資料夾，寫在裡面會再觸發掃描、無限循環。
STATUS_FILE="/var/lib/docker/volumes/nextags_app-data/_data/navidrome_status/status.json"
DEBOUNCE_SECONDS="${DEBOUNCE_SECONDS:-30}"

exec >>"$LOG_FILE" 2>&1

log() {
  printf '%s %s\n' "$(date -Is)" "$*"
}

request_requested_at() {
  sed -n 's/.*"requested_at": *"\([^"]*\)".*/\1/p' "$REQUEST_FILE" 2>/dev/null | head -n 1
}

write_status() {
  local ok="$1" requested_at="$2" tmp
  mkdir -p "$(dirname "$STATUS_FILE")"
  tmp="${STATUS_FILE}.tmp"
  printf '{"ok": %s, "request_requested_at": "%s", "completed_at": "%s"}\n' \
    "$ok" "$requested_at" "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$STATUS_FILE"
}

run_refresh() {
  if [ -f "$REQUEST_FILE" ]; then
    log "request: $(tr '\n' ' ' < "$REQUEST_FILE")"
  else
    log "request file not found: $REQUEST_FILE"
  fi

  if [ ! -d "/mnt/googletu/60 - 音樂中心/B 人聲" ]; then
    log "music mount is not ready"
    return 1
  fi

  cd /opt/music-stack
  docker compose up -d --force-recreate --no-deps navidrome

  for _ in $(seq 1 30); do
    if docker exec navidrome sh -lc 'test -d /music && test -d /libraries/a' >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  docker exec navidrome /app/navidrome scan --datafolder /data --musicfolder /music --cachefolder /cache
}

(
  flock -n 9 || {
    log "skip: another refresh hook is running"
    exit 0
  }

  last_seen_mtime=0

  while true; do
    log "hook triggered; debounce ${DEBOUNCE_SECONDS}s"
    sleep "$DEBOUNCE_SECONDS"

    request_mtime=$(stat -c %Y "$REQUEST_FILE" 2>/dev/null || echo 0)
    if [ "$request_mtime" -le "$last_seen_mtime" ]; then
      log "no newer request; done"
      exit 0
    fi

    # 在掃描開始前記下這次涵蓋的請求時間；掃描期間的新請求會在下一輪處理
    requested_at="$(request_requested_at)"
    if ! run_refresh; then
      write_status false "$requested_at"
      log "refresh failed"
      exit 1
    fi
    write_status true "$requested_at"
    last_seen_mtime="$request_mtime"
    log "refresh completed (request_requested_at=${requested_at})"

    latest_mtime=$(stat -c %Y "$REQUEST_FILE" 2>/dev/null || echo 0)
    if [ "$latest_mtime" -le "$last_seen_mtime" ]; then
      exit 0
    fi
  done
) 9>"$LOCK_FILE"
