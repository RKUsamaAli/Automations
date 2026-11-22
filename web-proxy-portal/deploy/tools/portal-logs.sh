#!/usr/bin/env bash
# =============================================================================
# portal-logs - follow application logs
#
#   sudo portal-logs            # both processes (PM2)
#   sudo portal-logs web        # only portal-web
#   sudo portal-logs proxy      # only portal-proxy
#   sudo portal-logs nginx      # nginx access + error logs
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
trap - ERR
require_root "$@"
load_config
case "${1:-all}" in
    web)   pm2_app logs portal-web --lines 100 ;;
    proxy) pm2_app logs portal-proxy --lines 100 ;;
    nginx) exec tail -n 50 -F /var/log/nginx/proxy-portal-*.log ;;
    *)     pm2_app logs --lines 50 ;;
esac
