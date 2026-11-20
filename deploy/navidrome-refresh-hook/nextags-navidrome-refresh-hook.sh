#!/usr/bin/env bash
set -euo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

LOG_FILE="/var/log/nextags-navidrome-refresh-hook.log"
REQUEST_FILE="/var/lib/docker/volumes/nextags_app-data/_data/navidrome_refresh/request.json"
LOCK_FILE="/run/nextags-navidrome-refresh-hook.lock"
DEBOUNCE_SECONDS="${DEBOUNCE_SECONDS:-30}"

exec >>"$LOG_FILE" 2>&1

log() {
  printf '%s %s\n' "$(date -Is)" "$*"
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

    run_refresh
    last_seen_mtime="$request_mtime"
    log "refresh completed"

    latest_mtime=$(stat -c %Y "$REQUEST_FILE" 2>/dev/null || echo 0)
    if [ "$latest_mtime" -le "$last_seen_mtime" ]; then
      exit 0
    fi
  done
) 9>"$LOCK_FILE"
