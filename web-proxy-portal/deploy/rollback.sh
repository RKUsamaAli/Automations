#!/usr/bin/env bash
# =============================================================================
# rollback.sh (portal-rollback) - switch back to an earlier release
#
#   sudo portal-rollback                 # to the release before the current one
#   sudo portal-rollback --list          # show releases you can roll back to
#   sudo portal-rollback --to 20261122153000_ab12cd3
#   sudo portal-rollback --restore-db    # ALSO restore the database backup taken
#                                        # right before the current release was deployed
#   sudo portal-rollback --yes           # no confirmation prompt
#
# A rollback does not rebuild anything: every release folder still has its
# own code, node_modules and engine build, so switching is a symlink swap +
# PM2 reload and takes a few seconds.
#
# Database: migrations are additive (new tables/columns only), so older code
# keeps working with the newer schema and you normally do NOT need
# --restore-db. Use it only if a release damaged data. It replaces the
# database with the pre-deploy backup: anything written since is lost
# (a safety copy of the current DB is saved first).
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

require_root "$@"
load_config

TARGET=""
RESTORE_DB=0
ASSUME_YES=0
LIST=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --to)         TARGET="$2"; shift 2 ;;
        --restore-db) RESTORE_DB=1; shift ;;
        --list|-l)    LIST=1; shift ;;
        --yes|-y)     ASSUME_YES=1; shift ;;
        -h|--help)    sed -n '2,24p' "$0"; exit 0 ;;
        *) die "Unknown option: $1 (see --help)" ;;
    esac
done

CURRENT="$(current_release)"

print_releases() {
    echo "Releases (newest last):"
    local r marker info
    for r in $(ls -1 "$RELEASES_DIR" 2>/dev/null | sort); do
        marker="  "
        [[ "$r" == "$CURRENT" ]] && marker="${C_GREEN}->${C_RESET}"
        info="$(grep -E '^(ref|deployed_at)=' "$RELEASES_DIR/$r/REVISION" 2>/dev/null | cut -d= -f2 | paste -sd' ' || true)"
        if [[ -e "$RELEASES_DIR/$r/.failed" ]]; then
            echo "  $marker $r  ${C_RED}(failed)${C_RESET}  $info"
        else
            echo "  $marker $r  $info"
        fi
    done
    echo
    echo "Recent history ($HISTORY_FILE):"
    tail -n 8 "$HISTORY_FILE" 2>/dev/null | sed 's/^/  /' || true
}

if (( LIST )); then
    print_releases
    exit 0
fi

acquire_lock
[[ -n "$CURRENT" ]] || die "Nothing is deployed yet."

if [[ -z "$TARGET" ]]; then
    TARGET="$(release_before "$CURRENT")"
    [[ -n "$TARGET" ]] || die "There is no earlier release to roll back to. (portal-rollback --list)"
fi
[[ -d "$RELEASES_DIR/$TARGET" ]] || die "Release '$TARGET' not found. (portal-rollback --list)"
[[ -e "$RELEASES_DIR/$TARGET/.failed" ]] && die "Release '$TARGET' is marked as failed; pick another one."
[[ "$TARGET" == "$CURRENT" ]] && die "'$TARGET' is already the current release."
[[ -e "$RELEASES_DIR/$TARGET/vendor/rammerhead/.build-ok" ]] || die "Engine build for '$TARGET' was removed; it cannot be started. Deploy that commit again instead."

BACKUP=""
if (( RESTORE_DB )); then
    BACKUP="$SHARED_DIR/backups/pre-deploy-${CURRENT}.db"
    [[ -f "$BACKUP" ]] || die "No pre-deploy backup for $CURRENT ($BACKUP)."
fi

echo
echo "  current : $CURRENT"
echo "  target  : $TARGET"
(( RESTORE_DB )) && echo "  database: restore $BACKUP (changes made since that deploy are LOST)"
echo
if (( ! ASSUME_YES )); then
    read -r -p "Proceed with rollback? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || die "Cancelled."
fi

STARTED=$(date +%s)
DB_FILE="$(app_env DATA_DIR "$SHARED_DIR/data")/portal.db"

if (( RESTORE_DB )); then
    step "Restoring database"
    # Stop writers, keep a safety copy of the current DB, then restore.
    pm2_app stop all >/dev/null || true
    SAFETY="$SHARED_DIR/backups/before-restore-$(date +%Y%m%d%H%M%S).db"
    if [[ -f "$DB_FILE" ]]; then
        (cd "$CURRENT_LINK" && as_app node src/cli/index.js backup-db "$SAFETY" >/dev/null)
        ok "Safety copy of the current database: $SAFETY"
    fi
    rm -f "$DB_FILE-wal" "$DB_FILE-shm"
    install -o "$APP_USER" -g "$APP_USER" -m 0640 "$BACKUP" "$DB_FILE"
    ok "Database restored from $BACKUP"
fi

step "Switching current -> $TARGET"
switch_current "$TARGET"
pm2_reload "$TARGET"

step "Health check"
if wait_healthy "$TARGET"; then
    history_add rollback "$TARGET" success "from=$CURRENT${BACKUP:+ db=restored}"
    ok "${C_BOLD}Rolled back to $TARGET in $(( $(date +%s) - STARTED ))s${C_RESET}"
    echo "    To go forward again:  sudo portal-rollback --to $CURRENT"
else
    show_recent_logs
    history_add rollback "$TARGET" failed "from=$CURRENT"
    err "Release $TARGET is not healthy. Switching back to $CURRENT."
    switch_current "$CURRENT"
    pm2_reload "$CURRENT" || true
    wait_healthy "$CURRENT" 60 && ok "Back on $CURRENT." || err "Also unhealthy - check: portal-logs"
    exit 1
fi
