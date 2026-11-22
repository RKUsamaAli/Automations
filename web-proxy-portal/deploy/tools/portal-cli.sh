#!/usr/bin/env bash
# =============================================================================
# portal-cli - run the application CLI as the app user, in the current release
#
#   sudo portal-cli create-admin admin            # prints a generated password
#   sudo portal-cli reset-password admin
#   sudo portal-cli create-user alice --token     # prints an access code
#   sudo portal-cli list-users
#   sudo portal-cli import-proxies "US resi" /root/proxies.txt
#   sudo portal-cli check-proxies
#   sudo portal-cli seed-examples                 # example injected scripts (disabled)
#   sudo portal-cli                               # full command list
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
trap - ERR
require_root "$@"
load_config
[[ -L "$CURRENT_LINK" ]] || die "Nothing deployed yet - run: sudo portal-deploy"

# Files passed as arguments (import-proxies) are often in /root: give the app
# user a readable temporary copy.
args=()
for a in "$@"; do
    if [[ -f "$a" && "$(stat -c %U "$a")" != "$APP_USER" ]]; then
        tmp="$(mktemp)"; cp "$a" "$tmp"; chown "$APP_USER" "$tmp"; args+=("$tmp")
    else
        args+=("$a")
    fi
done
cd "$CURRENT_LINK" && exec sudo -u "$APP_USER" -H node src/cli/index.js "${args[@]}"
