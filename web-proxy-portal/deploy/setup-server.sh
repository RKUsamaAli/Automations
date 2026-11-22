#!/usr/bin/env bash
# =============================================================================
# setup-server.sh - one-time provisioning of a fresh Ubuntu 22.04 / 24.04 VPS
#
# What it does (safe to re-run; every step checks before it changes anything):
#    1. System update + base packages (git, build tools, nginx, certbot, ufw, fail2ban ...)
#    2. Timezone, swap file (avoids Node.js out-of-memory on small VPS), kernel tuning
#    3. Node.js LTS + PM2
#    4. App user "portal" and the directory layout under /opt/proxy-portal
#    5. App config /opt/proxy-portal/shared/.env with generated secrets
#    6. GitHub deploy key (read-only) for a private repository
#    7. Firewall (SSH, 80, 443, 8443), fail2ban, automatic security updates
#    8. nginx + HTTPS certificate (Let's Encrypt) for both hostnames
#    9. PM2 boot service, log rotation, daily DB backup cron
#   10. Installs the commands: portal-deploy, portal-rollback, portal-status,
#       portal-backup, portal-cli, portal-restart, portal-logs, portal-setup
#
# Usage (from a checkout of the repository on the server):
#   sudo ./setup-server.sh \
#        --app-domain portal.example.com --proxy-domain browse.example.com \
#        --email you@example.com --repo git@github.com:rkusamaali/automations.git
#
#   sudo ./setup-server.sh                 # re-run with values from /etc/proxy-portal/deploy.env
#   sudo ./setup-server.sh --ssl-only      # (re)issue the certificate + nginx config only
#   sudo ./setup-server.sh --nginx-only    # re-render nginx config only
#   sudo ./setup-server.sh --scripts-only  # re-install the portal-* commands only
#
# All options:
#   --app-domain D   --proxy-domain D   --email E   --repo URL   --branch B
#   --ssl-mode letsencrypt|custom|none   --cert PATH --key PATH (custom)
#   --ssh-port N   --swap-mb N   --node-major N   --yes (no prompts)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }

require_root "$@"
require_ubuntu

# ------------------------------------------------------------ arguments ---
MODE="full"
ASSUME_YES=0
declare -A OPT=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --app-domain)   OPT[APP_DOMAIN]="$2"; shift 2 ;;
        --proxy-domain) OPT[PROXY_DOMAIN]="$2"; shift 2 ;;
        --email)        OPT[LETSENCRYPT_EMAIL]="$2"; shift 2 ;;
        --repo)         OPT[REPO_URL]="$2"; shift 2 ;;
        --branch)       OPT[REPO_BRANCH]="$2"; shift 2 ;;
        --ssl-mode)     OPT[SSL_MODE]="$2"; shift 2 ;;
        --cert)         OPT[SSL_CERT_PATH]="$2"; shift 2 ;;
        --key)          OPT[SSL_KEY_PATH]="$2"; shift 2 ;;
        --ssh-port)     OPT[SSH_PORT]="$2"; shift 2 ;;
        --swap-mb)      OPT[SWAP_SIZE_MB]="$2"; shift 2 ;;
        --node-major)   OPT[NODE_MAJOR]="$2"; shift 2 ;;
        --ssl-only)     MODE="ssl"; shift ;;
        --nginx-only)   MODE="nginx"; shift ;;
        --scripts-only) MODE="scripts"; shift ;;
        --yes|-y)       ASSUME_YES=1; shift ;;
        -h|--help)      sed -n '2,40p' "$0"; exit 0 ;;
        *) die "Unknown option: $1 (see --help)" ;;
    esac
done

# ------------------------------------------------- service management ---
# A normal VPS runs systemd. Containers / WSL often do not: fall back to the
# `service` command or start the daemon directly, and say what was skipped.
HAS_SYSTEMD=0
[[ -d /run/systemd/system ]] && HAS_SYSTEMD=1

svc_enable_start() { # svc_enable_start <name>
    if (( HAS_SYSTEMD )); then
        systemctl enable --now "$1" >/dev/null 2>&1 || systemctl restart "$1"
    else
        service "$1" start >/dev/null 2>&1 || warn "No systemd: could not start $1 (start it manually)."
    fi
}
svc_restart() {
    if (( HAS_SYSTEMD )); then systemctl restart "$1"; else service "$1" restart >/dev/null 2>&1 || service "$1" start >/dev/null 2>&1 || warn "No systemd: could not restart $1."; fi
}
nginx_reload() {
    if (( HAS_SYSTEMD )); then
        systemctl enable nginx >/dev/null 2>&1 || true
        systemctl reload nginx 2>/dev/null || systemctl restart nginx
    elif pgrep -x nginx >/dev/null; then
        nginx -s reload
    else
        nginx
    fi
}

# --------------------------------------------------------- deploy.env ---
# Creates /etc/proxy-portal/deploy.env on first run, then applies any CLI overrides.
set_config_value() {
    local key="$1" value="$2"
    if grep -qE "^${key}=" "$DEPLOY_CONFIG"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$DEPLOY_CONFIG"
    else
        echo "${key}=${value}" >> "$DEPLOY_CONFIG"
    fi
}

prompt_value() {
    # prompt_value KEY "Question" -> asks only when value still looks like the example
    local key="$1" question="$2" current
    current="$(grep -E "^${key}=" "$DEPLOY_CONFIG" | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' || true)"
    if [[ -z "$current" || "$current" == *example.com* ]]; then
        (( ASSUME_YES )) && die "$key is not set. Pass it as an option (see --help)."
        read -r -p "$question: " current
        [[ -n "$current" ]] || die "$key is required."
        set_config_value "$key" "$current"
    fi
}

init_config() {
    mkdir -p "$(dirname "$DEPLOY_CONFIG")"
    if [[ ! -f "$DEPLOY_CONFIG" ]]; then
        cp "$SCRIPT_DIR/config/deploy.env.example" "$DEPLOY_CONFIG"
        chmod 600 "$DEPLOY_CONFIG"
        ok "Created $DEPLOY_CONFIG"
    fi
    local k
    for k in "${!OPT[@]}"; do set_config_value "$k" "${OPT[$k]}"; done
    prompt_value APP_DOMAIN "Portal hostname (login/admin), e.g. portal.yourdomain.com"
    prompt_value PROXY_DOMAIN "Proxy hostname (browsing), e.g. browse.yourdomain.com"
    if grep -q '^SSL_MODE=letsencrypt' "$DEPLOY_CONFIG"; then
        prompt_value LETSENCRYPT_EMAIL "E-mail for Let's Encrypt expiry notices"
    fi
    load_config
    [[ "$APP_DOMAIN" != "$PROXY_DOMAIN" ]] || die "APP_DOMAIN and PROXY_DOMAIN must be different hostnames."
}

# ------------------------------------------------------- 1. packages ---
install_packages() {
    step "1/10 System packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git build-essential python3 \
        nginx certbot ufw fail2ban unattended-upgrades \
        sqlite3 jq logrotate rsync cron
    ok "Packages installed"
}

# ------------------------------------------------- 2. system tuning ---
tune_system() {
    step "2/10 Timezone, swap, kernel limits"
    if (( HAS_SYSTEMD )); then
        timedatectl set-timezone "${TIMEZONE:-UTC}" || warn "Could not set timezone"
    else
        ln -sf "/usr/share/zoneinfo/${TIMEZONE:-UTC}" /etc/localtime && echo "${TIMEZONE:-UTC}" > /etc/timezone
    fi

    local swap_mb="${SWAP_SIZE_MB:-2048}"
    if (( swap_mb > 0 )) && ! swapon --show | grep -q '/swapfile'; then
        log "Creating ${swap_mb}MB swap file (protects small VPS from Node.js OOM crashes)"
        if { fallocate -l "${swap_mb}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$swap_mb"; } \
            && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
            grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
            ok "Swap enabled"
        else
            rm -f /swapfile
            warn "Could not enable swap (not permitted here, e.g. inside a container) - skipped."
        fi
    else
        ok "Swap already configured (or disabled)"
    fi

    cat > /etc/sysctl.d/90-proxy-portal.conf <<'EOF'
# Web Proxy Portal tuning (setup-server.sh)
vm.swappiness = 10
fs.file-max = 200000
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.ip_local_port_range = 10240 65000
net.ipv4.tcp_fin_timeout = 20
EOF
    sysctl --system >/dev/null 2>&1 || warn "Some kernel settings could not be applied here (container?) - skipped."
    cat > /etc/security/limits.d/90-proxy-portal.conf <<EOF
${APP_USER} soft nofile 65535
${APP_USER} hard nofile 65535
EOF
    ok "Kernel and file-descriptor limits tuned"
}

# ------------------------------------------------------ 3. node + pm2 ---
install_node() {
    step "3/10 Node.js ${NODE_MAJOR:-22} + PM2"
    local want="${NODE_MAJOR:-22}" have=""
    command -v node >/dev/null && have="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [[ "$have" != "$want" ]]; then
        log "Installing Node.js ${want}.x from NodeSource"
        install -d -m 0755 /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${want}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
        apt-get update -y
        apt-get install -y nodejs
    fi
    ok "Node.js $(node -v), npm $(npm -v)"
    if ! command -v pm2 >/dev/null; then
        npm install -g pm2@latest --no-audit --no-fund
    fi
    ok "PM2 $(pm2 -v 2>/dev/null | tail -n1)"
}

# ------------------------------------------- 4. user + directory layout ---
create_layout() {
    step "4/10 App user and directories"
    if ! id "$APP_USER" >/dev/null 2>&1; then
        useradd --create-home --shell /bin/bash --comment "Web Proxy Portal" "$APP_USER"
        ok "Created user $APP_USER"
    fi
    load_config # refresh APP_HOME
    # /opt/proxy-portal
    # |-- current -> releases/<timestamp>_<commit>   (what is running)
    # |-- releases/                                   (one folder per deploy)
    # |-- repo.git/                                   (git mirror, fast fetches)
    # |-- scripts/                                    (installed deploy scripts)
    # `-- shared/                                     (survives deploys)
    #     |-- .env  data/  logs/  backups/  vendor/
    install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$BASE_DIR" "$RELEASES_DIR" "$SHARED_DIR"
    install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$SHARED_DIR/data" "$SHARED_DIR/logs" "$SHARED_DIR/backups" "$SHARED_DIR/vendor"
    install -d -m 0755 /var/www/letsencrypt
    touch "$HISTORY_FILE"
    chown "$APP_USER:$APP_USER" "$HISTORY_FILE"
    ok "Layout ready under $BASE_DIR"
}

# ------------------------------------------------------- 5. app .env ---
create_app_env() {
    step "5/10 Application config ($APP_ENV_FILE)"
    # Repo checkout: deploy/../app/.env.example. Installed copy: scripts/templates/app.env.example
    local example="$SCRIPT_DIR/../app/.env.example"
    [[ -r "$example" ]] || example="$SCRIPT_DIR/templates/app.env.example"
    [[ -r "$example" ]] || die "Cannot find app/.env.example - run this script from the repository checkout."
    local proto="https" port=443
    [[ "${SSL_MODE:-letsencrypt}" == "none" ]] && { proto="http"; port=80; }

    if [[ ! -f "$APP_ENV_FILE" ]]; then
        cp "$example" "$APP_ENV_FILE"
        local secret deploy_secret
        secret="$(openssl rand -hex 48)"
        deploy_secret="$(openssl rand -hex 16)"
        sed -i \
            -e "s|^APP_SECRET=.*|APP_SECRET=${secret}|" \
            -e "s|^DEPLOY_SECRET=.*|DEPLOY_SECRET=${deploy_secret}|" \
            -e "s|^DATA_DIR=.*|DATA_DIR=${SHARED_DIR}/data|" \
            "$APP_ENV_FILE"
        # Size memory guards to this machine's RAM.
        local mem_mb
        mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
        if (( mem_mb < 900 )); then
            sed -i -e 's|^WEB_MAX_MEMORY=.*|WEB_MAX_MEMORY=150M|' -e 's|^PROXY_MAX_MEMORY=.*|PROXY_MAX_MEMORY=350M|' \
                -e 's|^PROXY_NODE_ARGS=.*|PROXY_NODE_ARGS=--max-old-space-size=384|' "$APP_ENV_FILE"
        elif (( mem_mb >= 3500 )); then
            local cpus; cpus="$(nproc)"
            sed -i -e 's|^PROXY_MAX_MEMORY=.*|PROXY_MAX_MEMORY=2500M|' -e 's|^PROXY_NODE_ARGS=.*|PROXY_NODE_ARGS=--max-old-space-size=2560|' \
                -e 's|^WEB_INSTANCES=.*|WEB_INSTANCES=2|' "$APP_ENV_FILE"
            (( cpus >= 2 )) && sed -i "s|^PROXY_WORKERS=.*|PROXY_WORKERS=${cpus}|; s|^PROXY_WORKER_MAX_MEMORY_MB=.*|PROXY_WORKER_MAX_MEMORY_MB=$(( mem_mb / cpus / 2 ))|" "$APP_ENV_FILE"
        fi
        ok "Created $APP_ENV_FILE with fresh secrets (RAM: ${mem_mb}MB)"
    else
        ok "$APP_ENV_FILE exists - keeping your secrets"
    fi
    # Domains/protocol always follow deploy.env.
    sed -i \
        -e "s|^APP_DOMAIN=.*|APP_DOMAIN=${APP_DOMAIN}|" \
        -e "s|^PROXY_DOMAIN=.*|PROXY_DOMAIN=${PROXY_DOMAIN}|" \
        -e "s|^PUBLIC_PROTOCOL=.*|PUBLIC_PROTOCOL=${proto}|" \
        -e "s|^PUBLIC_PORT=.*|PUBLIC_PORT=${port}|" \
        "$APP_ENV_FILE"
    chown "$APP_USER:$APP_USER" "$APP_ENV_FILE"
    chmod 600 "$APP_ENV_FILE"
}

# ---------------------------------------------------- 6. deploy key ---
setup_deploy_key() {
    step "6/10 Repository access"
    if [[ "$REPO_URL" != git@* && "$REPO_URL" != ssh://* ]]; then
        ok "HTTPS repository URL - no deploy key needed (repository must be public)"
        return
    fi
    local ssh_dir="$APP_HOME/.ssh" key="$APP_HOME/.ssh/id_ed25519"
    install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$ssh_dir"
    if [[ ! -f "$key" ]]; then
        as_app ssh-keygen -t ed25519 -N '' -C "proxy-portal-deploy@$(hostname)" -f "$key" >/dev/null
    fi
    local host; host="$(echo "$REPO_URL" | sed -E 's|^(ssh://)?git@([^:/]+).*|\2|')"
    if ! as_app ssh-keygen -F "$host" >/dev/null 2>&1; then
        ssh-keyscan -t ed25519,rsa "$host" 2>/dev/null >> "$ssh_dir/known_hosts"
        chown "$APP_USER:$APP_USER" "$ssh_dir/known_hosts"
    fi
    if as_app env GIT_SSH_COMMAND="ssh -o BatchMode=yes" git ls-remote "$REPO_URL" >/dev/null 2>&1; then
        ok "Deploy key already has access to $REPO_URL"
    else
        warn "Add this READ-ONLY deploy key to GitHub before the first deploy:"
        warn "  Repo -> Settings -> Deploy keys -> Add deploy key (leave 'Allow write access' unticked)"
        echo
        cat "$key.pub"
        echo
    fi
}

# ------------------------------------------------- 7. firewall etc. ---
setup_security() {
    step "7/10 Firewall, fail2ban, automatic security updates"
    local ssh_port="${SSH_PORT:-22}"
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
    ufw allow "${ssh_port}/tcp" comment 'SSH' >/dev/null
    ufw allow 80/tcp comment 'HTTP (ACME + redirect)' >/dev/null
    ufw allow 443/tcp comment 'HTTPS' >/dev/null
    ufw allow 8443/tcp comment 'Proxy cross-domain port' >/dev/null
    if ufw --force enable >/dev/null 2>&1; then
        ok "ufw: allowing ${ssh_port}, 80, 443, 8443"
    else
        warn "FIREWALL NOT ACTIVE: ufw could not be enabled here (no kernel permission, e.g. a container)."
        warn "On a real VPS this must succeed - check: sudo ufw status"
    fi

    cat > /etc/fail2ban/jail.d/proxy-portal.local <<EOF
# Web Proxy Portal (setup-server.sh)
[sshd]
enabled  = true
port     = ${ssh_port}
maxretry = 5
bantime  = 1h

[nginx-limit-req]
enabled  = true
port     = http,https,8443
logpath  = /var/log/nginx/proxy-portal-*.error.log
maxretry = 30
findtime = 60
bantime  = 10m
EOF
    svc_enable_start fail2ban
    svc_restart fail2ban
    ok "fail2ban configured (sshd + nginx rate-limit abuse)"

    cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
    ok "Unattended security upgrades enabled"
}

# --------------------------------------------------- 8. nginx + SSL ---
write_nginx() {
    local variant="$1" cert="${2:-}" key="${3:-}"
    install -m 0644 "$SCRIPT_DIR/templates/proxy-portal-upstream.conf" /etc/nginx/snippets/proxy-portal-upstream.conf
    install -m 0644 "$SCRIPT_DIR/templates/proxy-portal-ssl.conf" /etc/nginx/snippets/proxy-portal-ssl.conf
    install -m 0644 "$SCRIPT_DIR/templates/proxy-portal-gzip.conf" /etc/nginx/snippets/proxy-portal-gzip.conf
    render_template "$SCRIPT_DIR/templates/nginx-${variant}.conf.tpl" /etc/nginx/sites-available/proxy-portal.conf \
        APP_DOMAIN="$APP_DOMAIN" PROXY_DOMAIN="$PROXY_DOMAIN" \
        WEB_PORT="$(app_env WEB_PORT 3000)" PROXY_PORT="$(app_env PROXY_PORT 8080)" \
        PROXY_CROSS_PORT="$(app_env PROXY_CROSS_DOMAIN_PORT 8081)" SSL_CERT="$cert" SSL_KEY="$key"
    # Hosts without IPv6 (some VPS plans, containers) cannot bind [::]:port.
    if [[ ! -s /proc/net/if_inet6 ]]; then
        sed -i '/listen \[::\]/d' /etc/nginx/sites-available/proxy-portal.conf
        log "No IPv6 on this host - nginx listens on IPv4 only"
    fi
    ln -sfn /etc/nginx/sites-available/proxy-portal.conf /etc/nginx/sites-enabled/proxy-portal.conf
    rm -f /etc/nginx/sites-enabled/default
    nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx config test failed"; }
    nginx_reload
}

setup_nginx_ssl() {
    step "8/10 nginx + HTTPS (${SSL_MODE:-letsencrypt})"
    case "${SSL_MODE:-letsencrypt}" in
        none)
            write_nginx http
            warn "SSL_MODE=none: serving plain HTTP. iOS Safari needs HTTPS - use only for testing."
            ;;
        custom)
            [[ -r "${SSL_CERT_PATH:-}" && -r "${SSL_KEY_PATH:-}" ]] || die "SSL_MODE=custom needs readable SSL_CERT_PATH and SSL_KEY_PATH in $DEPLOY_CONFIG"
            write_nginx https "$SSL_CERT_PATH" "$SSL_KEY_PATH"
            ok "nginx using your certificate $SSL_CERT_PATH"
            ;;
        letsencrypt)
            local live="/etc/letsencrypt/live/proxy-portal"
            if [[ ! -f "$live/fullchain.pem" ]]; then
                # Serve the ACME challenge over plain HTTP first.
                write_nginx http
                local ip; ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '?')"
                log "Requesting a certificate for $APP_DOMAIN and $PROXY_DOMAIN (both must resolve to this server: $ip)"
                if ! certbot certonly --webroot -w /var/www/letsencrypt --cert-name proxy-portal \
                        -d "$APP_DOMAIN" -d "$PROXY_DOMAIN" --email "$LETSENCRYPT_EMAIL" \
                        --agree-tos --non-interactive --keep-until-expiring; then
                    warn "Certificate request failed. Usually DNS is not pointing here yet."
                    warn "Create A records for $APP_DOMAIN and $PROXY_DOMAIN -> $ip, wait a few minutes, then run:"
                    warn "  sudo portal-setup --ssl-only"
                    warn "Until then the portal is served over plain HTTP."
                    return 0
                fi
            fi
            write_nginx https "$live/fullchain.pem" "$live/privkey.pem"
            # Reload nginx whenever certbot renews (certbot.timer runs twice a day).
            install -d /etc/letsencrypt/renewal-hooks/deploy
            printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
            chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
            sed -i "s|^PUBLIC_PROTOCOL=.*|PUBLIC_PROTOCOL=https|; s|^PUBLIC_PORT=.*|PUBLIC_PORT=443|" "$APP_ENV_FILE"
            ok "HTTPS active (auto-renewal via certbot.timer)"
            ;;
        *) die "Unknown SSL_MODE=${SSL_MODE}" ;;
    esac
}

# ------------------------------------------------ 9. pm2 + cron ---
setup_pm2_and_cron() {
    step "9/10 PM2 boot service, log rotation, backups"
    # Start PM2 (and the saved app list) at boot, as the app user.
    if (( HAS_SYSTEMD )); then
        env PATH="$PATH" "$(pm2_bin)" startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
        systemctl enable "pm2-${APP_USER}" >/dev/null 2>&1 || true
    else
        warn "No systemd: PM2 will not start automatically after a reboot (run: sudo portal-restart)."
    fi
    # Rotate app logs: 20MB per file, 14 files.
    if ! pm2_app ls -m 2>/dev/null | grep -q pm2-logrotate; then
        pm2_app install pm2-logrotate >/dev/null 2>&1 || warn "Could not install pm2-logrotate (logs will not rotate)"
    fi
    pm2_app set pm2-logrotate:max_size 20M >/dev/null 2>&1 || true
    pm2_app set pm2-logrotate:retain 14 >/dev/null 2>&1 || true
    pm2_app set pm2-logrotate:compress true >/dev/null 2>&1 || true

    cat > /etc/cron.d/proxy-portal <<EOF
# Web Proxy Portal (setup-server.sh)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Daily database + config backup at 03:17
17 3 * * * root /usr/local/bin/portal-backup --quiet >> ${SHARED_DIR}/logs/backup.log 2>&1
EOF
    chmod 644 /etc/cron.d/proxy-portal
    svc_enable_start cron
    if (( HAS_SYSTEMD )); then ok "PM2 starts on boot (service pm2-${APP_USER}); daily backup at 03:17"; else ok "Daily backup at 03:17"; fi
}

# ---------------------------------------------- 10. install commands ---
install_scripts() {
    step "10/10 Installing portal-* commands"
    install -d -m 0755 "$SCRIPTS_DIR"
    if [[ "$SCRIPT_DIR" != "$SCRIPTS_DIR" ]]; then
        rsync -a --delete --exclude 'templates/app.env.example' "$SCRIPT_DIR/" "$SCRIPTS_DIR/"
        # Keep a copy of the app's .env.example so `portal-setup` works from the installed copy.
        if [[ -r "$SCRIPT_DIR/../app/.env.example" ]]; then
            cp "$SCRIPT_DIR/../app/.env.example" "$SCRIPTS_DIR/templates/app.env.example"
        fi
    fi
    chmod +x "$SCRIPTS_DIR"/*.sh "$SCRIPTS_DIR"/tools/*.sh
    local name
    for name in deploy rollback status backup; do
        ln -sfn "$SCRIPTS_DIR/${name}.sh" "/usr/local/bin/portal-${name}"
    done
    ln -sfn "$SCRIPTS_DIR/setup-server.sh" /usr/local/bin/portal-setup
    ln -sfn "$SCRIPTS_DIR/tools/portal-cli.sh" /usr/local/bin/portal-cli
    ln -sfn "$SCRIPTS_DIR/tools/portal-restart.sh" /usr/local/bin/portal-restart
    ln -sfn "$SCRIPTS_DIR/tools/portal-logs.sh" /usr/local/bin/portal-logs
    ok "Commands: portal-deploy portal-rollback portal-status portal-backup portal-cli portal-restart portal-logs portal-setup"
}

summary() {
    echo
    echo "${C_GREEN}${C_BOLD}Server setup complete.${C_RESET}"
    cat <<EOF

Next steps
  1. DNS: A records  ${APP_DOMAIN}  and  ${PROXY_DOMAIN}  ->  this server's IP
     (then, if HTTPS was skipped:  sudo portal-setup --ssl-only)
  2. If a deploy key was printed above, add it to the GitHub repo (read-only).
  3. Deploy the application:        sudo portal-deploy
  4. Create the first admin:        sudo portal-cli create-admin admin
  5. Open https://${APP_DOMAIN}/admin  -> Proxy pools -> import your proxies.

Useful commands
  portal-status            what is running, releases, health
  portal-deploy --ref v1.2 deploy a branch / tag / commit
  portal-rollback          go back to the previous release
  portal-logs              follow the application logs
  Config: ${DEPLOY_CONFIG} (deploy)  and  ${APP_ENV_FILE} (app)
EOF
}

# ------------------------------------------------------------------ main ---
init_config
case "$MODE" in
    ssl|nginx)
        # Re-renders nginx; with letsencrypt it (re)requests the certificate if missing.
        setup_nginx_ssl
        if [[ -L "$CURRENT_LINK" ]]; then
            log "Restarting the app so it picks up the protocol change"
            pm2_reload "$(current_release)" || true
        fi
        ;;
    scripts)
        install_scripts
        ;;
    full)
        install_packages
        tune_system
        install_node
        create_layout
        create_app_env
        setup_deploy_key
        setup_security
        setup_nginx_ssl
        setup_pm2_and_cron
        install_scripts
        # Re-run on a server that already runs the app: pick up .env changes
        # (e.g. PUBLIC_PROTOCOL=https after switching on Let's Encrypt).
        if [[ -L "$CURRENT_LINK" ]]; then
            log "Restarting the app so it picks up configuration changes"
            pm2_reload "$(current_release)" || true
        fi
        summary
        ;;
esac
