#!/usr/bin/env bash
# =============================================================================
# backup.sh (portal-backup) - back up the database and configuration
#
#   sudo portal-backup            # runs daily from /etc/cron.d/proxy-portal
#   sudo portal-backup --quiet
#
# Creates shared/backups/daily-<date>.tar.gz containing:
#   portal.db  (consistent online copy, safe while the app runs)
#   .env       (app secrets)   deploy.env (deploy settings)
# and keeps the newest KEEP_DB_BACKUPS archives.
#
# Copy these archives OFF the server too (e.g. rclone/scp to object storage) -
# a backup on the same disk does not survive losing the VPS.
#
# Restore:  sudo -u portal pm2 stop all
#           tar -xzf daily-<date>.tar.gz -C /tmp/restore
#           cp /tmp/restore/portal.db /opt/proxy-portal/shared/data/portal.db
#           sudo portal-restart
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_root "$@"
load_config
QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

DB_FILE="$(app_env DATA_DIR "$SHARED_DIR/data")/portal.db"
[[ -f "$DB_FILE" ]] || die "No database at $DB_FILE yet."

STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[[ -L "$CURRENT_LINK" ]] || die "Nothing deployed yet."
chown "$APP_USER" "$WORK"
# Online backup through the app (better-sqlite3 backup API + integrity check).
(cd "$CURRENT_LINK" && as_app node src/cli/index.js backup-db "$WORK/portal.db" >/dev/null)
cp "$APP_ENV_FILE" "$WORK/.env"
cp "$DEPLOY_CONFIG" "$WORK/deploy.env"

ARCHIVE="$SHARED_DIR/backups/daily-${STAMP}.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" portal.db .env deploy.env
chown "$APP_USER:$APP_USER" "$ARCHIVE"
chmod 600 "$ARCHIVE"

find "$SHARED_DIR/backups" -maxdepth 1 -name 'daily-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +$(( KEEP_DB_BACKUPS + 1 )) | cut -d' ' -f2- | xargs -r rm -f || true

(( QUIET )) || ok "Backup written: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
(( QUIET )) && echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] backup ok: $ARCHIVE"
exit 0
