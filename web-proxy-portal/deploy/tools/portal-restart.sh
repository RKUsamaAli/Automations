#!/usr/bin/env bash
# =============================================================================
# portal-restart - restart both app processes (after editing shared/.env)
#
#   sudo portal-restart
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }
require_root "$@"
load_config
acquire_lock
release="$(current_release)"
[[ -n "$release" ]] || die "Nothing deployed yet - run: sudo portal-deploy"
log "Restarting $release"
export PORTAL_BASE_DIR="$BASE_DIR"
pm2_app startOrRestart "$CURRENT_LINK/ecosystem.config.js" --update-env >/dev/null
pm2_app save --force >/dev/null
wait_healthy "$release" && ok "Restarted and healthy." || { show_recent_logs; die "Not healthy after restart."; }
