#!/usr/bin/env bash
# =============================================================================
# portal-logs - follow application logs
#
#   sudo portal-logs            # both processes (PM2)
#   sudo portal-logs web        # only portal-web
#   sudo portal-logs proxy      # only portal-proxy
#   sudo portal-logs nginx      # nginx access + error logs
#   sudo portal-logs errors     # only error lines of both processes (JSON, via jq)
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }
trap - ERR
require_root "$@"
load_config
case "${1:-all}" in
    web)   pm2_app logs portal-web --lines 100 ;;
    proxy) pm2_app logs portal-proxy --lines 100 ;;
    nginx) exec tail -n 50 -F /var/log/nginx/proxy-portal-*.log ;;
    errors) tail -n 200 -F "$SHARED_DIR"/logs/web.err.log "$SHARED_DIR"/logs/proxy.err.log \
                | grep --line-buffered '"level":"error"' | jq -c --unbuffered '{ts, scope, msg, ref, user, dest, requestId}' 2>/dev/null ;;
    *)     pm2_app logs --lines 50 ;;
esac
