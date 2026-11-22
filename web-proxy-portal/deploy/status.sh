#!/usr/bin/env bash
# =============================================================================
# status.sh (portal-status) - one screen overview of the server
#
#   sudo portal-status
# Shows: current release, health of both services, PM2 processes, releases
# available for rollback, certificate expiry, disk and memory.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
trap - ERR
set +e

require_root "$@"
load_config

CURRENT="$(current_release)"
echo "${C_BOLD}Web Proxy Portal${C_RESET}   $(hostname)   $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "  portal : ${APP_DOMAIN}    proxy : ${PROXY_DOMAIN}"
echo "  current: ${CURRENT:-<nothing deployed>}"
[[ -n "$CURRENT" ]] && grep -E '^(commit|ref|deployed_at|deployed_by)=' "$RELEASES_DIR/$CURRENT/REVISION" 2>/dev/null | sed 's/^/           /'

echo
echo "${C_BOLD}Health${C_RESET}"
web_port="$(app_env WEB_PORT 3000)"
proxy_port="$(app_env PROXY_PORT 8080)"
for svc in "portal-web|http://127.0.0.1:${web_port}/healthz" "portal-proxy|http://127.0.0.1:${proxy_port}/__portal/healthz"; do
    name="${svc%%|*}"; url="${svc#*|}"
    if body="$(curl -fsS --max-time 3 "$url" 2>/dev/null)"; then
        ok "$name  $body"
    else
        err "$name  not responding ($url)"
    fi
done

echo
echo "${C_BOLD}Processes${C_RESET}"
pm2_app ls 2>/dev/null || warn "PM2 is not running for user $APP_USER"

echo
echo "${C_BOLD}Releases${C_RESET} (portal-rollback --to <name>)"
for r in $(ls -1 "$RELEASES_DIR" 2>/dev/null | sort); do
    mark="   "; [[ "$r" == "$CURRENT" ]] && mark=" ->"
    [[ -e "$RELEASES_DIR/$r/.failed" ]] && echo "$mark $r (failed)" || echo "$mark $r"
done

echo
echo "${C_BOLD}TLS certificate${C_RESET}"
cert="/etc/letsencrypt/live/proxy-portal/fullchain.pem"
[[ "${SSL_MODE:-}" == "custom" ]] && cert="${SSL_CERT_PATH:-}"
if [[ -r "$cert" ]]; then
    echo "  expires: $(openssl x509 -enddate -noout -in "$cert" | cut -d= -f2)"
else
    echo "  none (SSL_MODE=${SSL_MODE:-?})"
fi

echo
echo "${C_BOLD}Resources${C_RESET}"
free -h | sed 's/^/  /'
df -h "$BASE_DIR" | sed 's/^/  /'
echo "  sessions on disk: $(find "$(app_env DATA_DIR "$SHARED_DIR/data")/sessions" -type f 2>/dev/null | wc -l)"
echo "  database size:    $(du -h "$(app_env DATA_DIR "$SHARED_DIR/data")/portal.db" 2>/dev/null | cut -f1)"
