#!/usr/bin/env bash
# =============================================================================
# common.sh - helpers shared by setup-server.sh, deploy.sh, rollback.sh ...
#
# Source it, don't run it:   source "$(dirname "$0")/lib/common.sh"
# =============================================================================

set -Eeuo pipefail

DEPLOY_CONFIG="${DEPLOY_CONFIG:-/etc/proxy-portal/deploy.env}"

# ----------------------------------------------------------------- logging ---
if [[ -t 1 ]]; then
    C_RESET=$'\e[0m'; C_BLUE=$'\e[34m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_BOLD=$'\e[1m'
else
    C_RESET=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BOLD=''
fi
log()     { echo "${C_BLUE}[$(date '+%H:%M:%S')]${C_RESET} $*"; }
ok()      { echo "${C_GREEN}[  OK  ]${C_RESET} $*"; }
warn()    { echo "${C_YELLOW}[ WARN ]${C_RESET} $*" >&2; }
err()     { echo "${C_RED}[ FAIL ]${C_RESET} $*" >&2; }
die()     { err "$*"; exit 1; }
step()    { echo; echo "${C_BOLD}==> $*${C_RESET}"; }

# Print the failing command and line on unexpected errors.
# shellcheck disable=SC2154
trap 'rc=$?; err "Command failed (exit $rc) at ${BASH_SOURCE[0]##*/}:${LINENO}: ${BASH_COMMAND}"' ERR

# ---------------------------------------------------------------- guards ---
require_root() {
    [[ $EUID -eq 0 ]] || die "Run this as root: sudo $0 $*"
}

require_ubuntu() {
    [[ -r /etc/os-release ]] || die "Cannot detect the OS (/etc/os-release missing)."
    # shellcheck disable=SC1091
    . /etc/os-release
    if [[ "${ID:-}" != "ubuntu" ]]; then
        die "This script supports Ubuntu 22.04 / 24.04 only (found: ${PRETTY_NAME:-unknown})."
    fi
    case "${VERSION_ID:-}" in
        22.04|24.04) ;;
        *) warn "Tested on Ubuntu 22.04 and 24.04; you have ${VERSION_ID}. Continuing anyway." ;;
    esac
}

# --------------------------------------------------------------- config ---
# shellcheck disable=SC2034  # variables are used by the scripts that source this file
load_config() {
    [[ -r "$DEPLOY_CONFIG" ]] || die "Config $DEPLOY_CONFIG not found. Run setup-server.sh first."
    # shellcheck disable=SC1090
    source "$DEPLOY_CONFIG"
    : "${APP_USER:?missing in $DEPLOY_CONFIG}" "${BASE_DIR:?missing in $DEPLOY_CONFIG}"
    RELEASES_DIR="$BASE_DIR/releases"
    SHARED_DIR="$BASE_DIR/shared"
    CURRENT_LINK="$BASE_DIR/current"
    REPO_MIRROR="$BASE_DIR/repo.git"
    SCRIPTS_DIR="$BASE_DIR/scripts"
    HISTORY_FILE="$BASE_DIR/releases.log"
    APP_ENV_FILE="$SHARED_DIR/.env"
    KEEP_RELEASES="${KEEP_RELEASES:-5}"
    KEEP_DB_BACKUPS="${KEEP_DB_BACKUPS:-14}"
    HEALTHCHECK_TIMEOUT="${HEALTHCHECK_TIMEOUT:-90}"
    APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6 || true)"
    APP_HOME="${APP_HOME:-/home/$APP_USER}"
}

# Reads KEY from the app's shared .env (falls back to $2).
app_env() {
    local key="$1" default="${2:-}" value=""
    if [[ -r "$APP_ENV_FILE" ]]; then
        value="$(grep -E "^${key}=" "$APP_ENV_FILE" | tail -n1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true)"
    fi
    echo "${value:-$default}"
}

# ------------------------------------------------------ run as app user ---
# as_app <command...>   runs a command as $APP_USER with its HOME (npm/pm2/ssh keys).
as_app() {
    sudo -u "$APP_USER" -H -- "$@"
}

# Absolute path of pm2: sudo's secure_path may not include npm's global bin dir.
pm2_bin() {
    command -v pm2 2>/dev/null || { [[ -x "$(npm prefix -g 2>/dev/null)/bin/pm2" ]] && echo "$(npm prefix -g)/bin/pm2"; } || echo pm2
}

# pm2 as the app user (PORTAL_BASE_DIR is passed through for ecosystem.config.js).
pm2_app() {
    sudo -u "$APP_USER" -H --preserve-env=PORTAL_BASE_DIR -- "$(pm2_bin)" "$@"
}

# -------------------------------------------------------------- releases ---
current_release() {
    # Empty when nothing is deployed or the link points at a deleted folder.
    if [[ -L "$CURRENT_LINK" && -d "$(readlink -f "$CURRENT_LINK")" ]]; then basename "$(readlink -f "$CURRENT_LINK")"; fi
    return 0
}

# Successful releases, oldest first (failed ones carry a .failed marker).
list_releases() {
    [[ -d "$RELEASES_DIR" ]] || return 0
    local d
    for d in $(ls -1 "$RELEASES_DIR" | sort); do
        [[ -d "$RELEASES_DIR/$d" && ! -e "$RELEASES_DIR/$d/.failed" ]] && echo "$d"
    done
    return 0
}

# Release just before $1 in time order.
release_before() {
    local target="$1" prev=""
    local r
    for r in $(list_releases); do
        [[ "$r" == "$target" ]] && { echo "$prev"; return 0; }
        prev="$r"
    done
    echo ""
}

# Atomically points current -> releases/<name>.
switch_current() {
    local name="$1"
    [[ -d "$RELEASES_DIR/$name" ]] || die "Release $name does not exist."
    ln -sfn "$RELEASES_DIR/$name" "$BASE_DIR/.current.tmp"
    mv -Tf "$BASE_DIR/.current.tmp" "$CURRENT_LINK"
}

history_add() {
    # history_add <action> <release> <status> [note]
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" "$2" "$3" "${4:-}" >> "$HISTORY_FILE"
}

# ------------------------------------------------------------- processes ---
# Starts or reloads both PM2 apps from the current release.
# Each process reports the release folder it runs from on /healthz, which is
# what wait_healthy() checks - so "healthy" always means "new code is live".
pm2_reload() {
    export PORTAL_BASE_DIR="$BASE_DIR"
    pm2_app startOrReload "$CURRENT_LINK/ecosystem.config.js" --update-env >/dev/null
    pm2_app save --force >/dev/null
}

# Waits until both services answer /healthz with the expected release name.
wait_healthy() {
    local release="$1" timeout="${2:-$HEALTHCHECK_TIMEOUT}"
    local web_port proxy_port deadline
    web_port="$(app_env WEB_PORT 3000)"
    proxy_port="$(app_env PROXY_PORT 8080)"
    deadline=$(( $(date +%s) + timeout ))
    local web_ok=0 proxy_ok=0 body
    while (( $(date +%s) < deadline )); do
        if (( ! web_ok )); then
            body="$(curl -fsS --max-time 3 "http://127.0.0.1:${web_port}/healthz" 2>/dev/null || true)"
            [[ "$body" == *"\"release\":\"${release}\""* ]] && web_ok=1
        fi
        if (( ! proxy_ok )); then
            body="$(curl -fsS --max-time 3 "http://127.0.0.1:${proxy_port}/__portal/healthz" 2>/dev/null || true)"
            [[ "$body" == *"\"release\":\"${release}\""* ]] && proxy_ok=1
        fi
        (( web_ok && proxy_ok )) && return 0
        sleep 2
    done
    (( web_ok )) || err "portal-web did not become healthy on :${web_port} within ${timeout}s"
    (( proxy_ok )) || err "portal-proxy did not become healthy on :${proxy_port} within ${timeout}s"
    return 1
}

show_recent_logs() {
    local logs="$SHARED_DIR/logs"
    warn "Last log lines (full logs: $logs):"
    tail -n 25 "$logs/web.err.log" "$logs/proxy.err.log" 2>/dev/null || true
}

# ------------------------------------------------------------------ lock ---
# Prevents two deploys/rollbacks running at the same time.
acquire_lock() {
    exec 9>/var/lock/proxy-portal-deploy.lock
    flock -n 9 || die "Another deploy or rollback is running. Try again in a minute."
}

# ------------------------------------------------------------- templates ---
# render_template <template> <dest> KEY=VALUE...   replaces {{KEY}} placeholders.
render_template() {
    local tpl="$1" dest="$2"; shift 2
    local content kv key value
    content="$(cat "$tpl")"
    for kv in "$@"; do
        key="${kv%%=*}"; value="${kv#*=}"
        content="${content//\{\{$key\}\}/$value}"
    done
    printf '%s\n' "$content" > "$dest"
}
