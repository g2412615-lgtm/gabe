#!/bin/sh
# Container startup: make sure the folders exist on the volume, start the
# off-site copies (only when the R2 secrets are set), then the web server.
#
# The app itself writes a database snapshot to /data/backups once a day and
# keeps the newest 14 (Fly also snapshots the whole volume daily). With the
# R2 secrets (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET;
# R2_PREFIX comes from fly.toml) the uploads and those snapshots are also
# copied to Cloudflare R2 every 30 minutes. Without them everything degrades
# to a plain start.
set -e
DATA="${DATA_DIR:-/data}"
mkdir -p "$DATA/uploads" "$DATA/assets" "$DATA/backups" "$DATA/tmp"

if [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_BUCKET" ]; then
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
  PREFIX="${R2_PREFIX:-blueprints}"
  # Wall-clock schedule: the machine is suspended when idle, which freezes a
  # plain `sleep`. The loop wakes every 5 minutes of awake time and copies
  # when the last good copy (a stamp file on the volume) is 30+ minutes old.
  # COPY, never sync: a file deleted here stays recoverable in R2.
  due() { # due <stamp-file> <seconds>
    [ ! -f "$1" ] || [ $(( $(date +%s) - $(cat "$1" 2>/dev/null || echo 0) )) -ge "$2" ]
  }
  (
    while true; do
      if due "$DATA/.last-r2-copy" 1800; then
        if rclone copy "$DATA/uploads" "r2:${R2_BUCKET}/${PREFIX}/uploads" --transfers 4 --s3-no-check-bucket >/dev/null 2>&1 \
          && rclone copy "$DATA/backups" "r2:${R2_BUCKET}/${PREFIX}/db" --s3-no-check-bucket --s3-upload-cutoff 1G >/dev/null 2>&1; then
          date +%s > "$DATA/.last-r2-copy"
          # only after a good copy may old snapshots roll off (kept 30 days)
          rclone delete "r2:${R2_BUCKET}/${PREFIX}/db" --min-age 30d --s3-no-check-bucket >/dev/null 2>&1 || true
        else
          echo "off-site copy failed (will retry)"
        fi
      fi
      sleep 300
    done
  ) &
fi

exec node --disable-warning=ExperimentalWarning dist/server/index.js
