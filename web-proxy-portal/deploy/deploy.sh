#!/usr/bin/env bash
# =============================================================================
# deploy.sh (portal-deploy) - deploy a new release with automatic rollback
#
#   sudo portal-deploy                      # latest commit of REPO_BRANCH
#   sudo portal-deploy --ref v1.4.0         # a tag, branch or commit sha
#   sudo portal-deploy --source /path/repo  # from a local checkout (no git fetch)
#   sudo portal-deploy --skip-tests         # skip `npm test`
#
# Steps (each release is a fresh folder; the running one is never modified):
#    1. fetch code            git mirror -> releases/<YYYYmmddHHMMSS>_<sha>/
#    2. install dependencies  npm ci (reuses node_modules if package-lock is unchanged)
#    3. Rammerhead engine     pinned in app/rammerhead.lock, built once & cached
#    4. link shared files     .env -> shared/.env
#    5. test                  npm test (aborts before anything goes live)
#    6. backup + migrate DB   shared/backups/pre-deploy-<release>.db, then migrations
#    7. switch                current -> new release (atomic symlink swap)
#    8. reload                PM2 reloads portal-web (zero downtime) and restarts portal-proxy
#    9. health check          both /healthz must report the NEW release
#   10. on failure            switch back to the previous release automatically
#   11. clean up              keep the last KEEP_RELEASES releases
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh" || { echo "Cannot load $SCRIPT_DIR/lib/common.sh" >&2; exit 1; }

require_root "$@"
load_config

REF="${REPO_BRANCH:-main}"
SOURCE_DIR=""
RUN_TESTS="${RUN_TESTS:-true}"
AUTO_ROLLBACK="${AUTO_ROLLBACK:-true}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ref)         REF="$2"; shift 2 ;;
        --source)      SOURCE_DIR="$(readlink -f "$2")"; shift 2 ;;
        --skip-tests)  RUN_TESTS=false; shift ;;
        --no-rollback) AUTO_ROLLBACK=false; shift ;;
        -h|--help)     sed -n '2,25p' "$0"; exit 0 ;;
        *) die "Unknown option: $1 (see --help)" ;;
    esac
done

acquire_lock
[[ -f "$APP_ENV_FILE" ]] || die "$APP_ENV_FILE missing - run setup-server.sh first."

PREVIOUS="$(current_release)"
STARTED=$(date +%s)
NEW_RELEASE=""
SWITCHED=0

# If anything fails before the switch, remove the half-built release.
# If it fails after the switch, roll back (when AUTO_ROLLBACK=true).
on_failure() {
    local rc=$?
    trap - ERR EXIT
    (( rc == 0 )) && return 0
    if [[ -n "$NEW_RELEASE" ]]; then
        if (( SWITCHED )); then
            show_recent_logs
            if [[ "$AUTO_ROLLBACK" == "true" && -n "$PREVIOUS" ]]; then
                warn "Rolling back to $PREVIOUS"
                switch_current "$PREVIOUS"
                pm2_reload "$PREVIOUS" || true
                if wait_healthy "$PREVIOUS" 60; then
                    ok "Rolled back to $PREVIOUS - the site is running the previous version."
                else
                    err "Previous release is not healthy either. Check: portal-logs"
                fi
                history_add rollback "$PREVIOUS" auto "after failed deploy of $NEW_RELEASE"
            fi
        fi
        touch "$RELEASES_DIR/$NEW_RELEASE/.failed" 2>/dev/null || true
        history_add deploy "$NEW_RELEASE" failed "ref=$REF"
        err "Deploy of $NEW_RELEASE FAILED. It is kept (marked .failed) for inspection: $RELEASES_DIR/$NEW_RELEASE"
    fi
    exit "$rc"
}
trap on_failure EXIT

# ------------------------------------------------------------ 1. fetch ---
step "1/9 Fetching code"
if [[ -n "$SOURCE_DIR" ]]; then
    [[ -d "$SOURCE_DIR/$APP_SUBDIR" ]] || die "$SOURCE_DIR/$APP_SUBDIR not found (is --source the repository root?)"
    SHA="$(git -C "$SOURCE_DIR" rev-parse --verify --quiet HEAD 2>/dev/null || echo local)"
    [[ -n "$(git -C "$SOURCE_DIR" status --porcelain 2>/dev/null || true)" ]] && SHA="${SHA:0:7}-dirty"
else
    if [[ ! -d "$REPO_MIRROR" ]]; then
        log "Cloning $REPO_URL (first deploy)"
        install -d -o "$APP_USER" -g "$APP_USER" "$REPO_MIRROR"
        as_app git clone --mirror --quiet "$REPO_URL" "$REPO_MIRROR"
    fi
    as_app git -C "$REPO_MIRROR" remote set-url origin "$REPO_URL"
    as_app git -C "$REPO_MIRROR" fetch --prune --quiet origin '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
    SHA="$(as_app git -C "$REPO_MIRROR" rev-parse --verify --quiet "${REF}^{commit}")" || die "Ref '$REF' not found in $REPO_URL"
fi
if [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then SHORT="${SHA:0:7}"; else SHORT="$(echo "$SHA" | tr -cd 'a-zA-Z0-9-' | cut -c1-13)"; fi
NEW_RELEASE="$(date +%Y%m%d%H%M%S)_${SHORT}"
RELEASE_DIR="$RELEASES_DIR/$NEW_RELEASE"
install -d -o "$APP_USER" -g "$APP_USER" "$RELEASE_DIR"

STRIP=$(( $(echo "$APP_SUBDIR" | tr -cd '/' | wc -c) + 1 ))
if [[ -n "$SOURCE_DIR" ]]; then
    rsync -a --exclude node_modules --exclude vendor --exclude data --exclude .env "$SOURCE_DIR/$APP_SUBDIR/" "$RELEASE_DIR/"
    rsync -a "$SOURCE_DIR/$DEPLOY_SUBDIR/" "$RELEASE_DIR/.deploy/"
    cp "$SOURCE_DIR/$APP_SUBDIR/.env.example" "$RELEASE_DIR/.deploy/templates/app.env.example" 2>/dev/null || true
    chown -R "$APP_USER:$APP_USER" "$RELEASE_DIR"
else
    as_app bash -c "git -C '$REPO_MIRROR' archive '$SHA' '$APP_SUBDIR' | tar -x -C '$RELEASE_DIR' --strip-components=$STRIP"
    # The deploy scripts of this commit (installed to $SCRIPTS_DIR after a successful deploy)
    as_app mkdir -p "$RELEASE_DIR/.deploy"
    DSTRIP=$(( $(echo "$DEPLOY_SUBDIR" | tr -cd '/' | wc -c) + 1 ))
    as_app bash -c "git -C '$REPO_MIRROR' archive '$SHA' '$DEPLOY_SUBDIR' | tar -x -C '$RELEASE_DIR/.deploy' --strip-components=$DSTRIP"
    as_app cp "$RELEASE_DIR/.env.example" "$RELEASE_DIR/.deploy/templates/app.env.example"
fi
[[ -f "$RELEASE_DIR/package.json" ]] || die "No package.json in the release - check APP_SUBDIR=$APP_SUBDIR"
cat > "$RELEASE_DIR/REVISION" <<EOF
release=$NEW_RELEASE
commit=$SHA
ref=$REF
deployed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
deployed_by=${SUDO_USER:-root}
EOF
ok "Release $NEW_RELEASE ($REF @ $SHORT)"

# ---------------------------------------------------- 2. dependencies ---
step "2/9 Installing dependencies"
PREV_DIR="${PREVIOUS:+$RELEASES_DIR/$PREVIOUS}"
if [[ -n "$PREV_DIR" && -d "$PREV_DIR/node_modules" ]] && cmp -s "$PREV_DIR/package-lock.json" "$RELEASE_DIR/package-lock.json" \
   && [[ "$(cat "$PREV_DIR/.node-version" 2>/dev/null)" == "$(node -v)" ]]; then
    as_app cp -a "$PREV_DIR/node_modules" "$RELEASE_DIR/node_modules"
    ok "package-lock.json unchanged - reused node_modules from $PREVIOUS"
else
    (cd "$RELEASE_DIR" && as_app npm ci --omit=dev --no-audit --no-fund --loglevel=error)
    ok "npm ci done"
fi
node -v | as_app tee "$RELEASE_DIR/.node-version" >/dev/null

# ------------------------------------------------------ 3. rammerhead ---
step "3/9 Rammerhead engine"
# shellcheck disable=SC1090,SC1091
source <(grep -E '^RAMMERHEAD_(REPO|COMMIT)=' "$RELEASE_DIR/rammerhead.lock")
: "${RAMMERHEAD_REPO:?missing in rammerhead.lock}" "${RAMMERHEAD_COMMIT:?missing in rammerhead.lock}"
RH_CACHE="$SHARED_DIR/vendor/rammerhead-${RAMMERHEAD_COMMIT:0:12}-node$(node -v | cut -d. -f1 | tr -d v)"
if [[ ! -f "$RH_CACHE/.build-ok" ]]; then
    log "Building Rammerhead ${RAMMERHEAD_COMMIT:0:12} (first time only, takes a few minutes)"
    rm -rf "$RH_CACHE"
    as_app git clone --quiet "$RAMMERHEAD_REPO" "$RH_CACHE"
    as_app git -C "$RH_CACHE" -c advice.detachedHead=false checkout --quiet "$RAMMERHEAD_COMMIT"
    (cd "$RH_CACHE" && as_app npm install --no-audit --no-fund --loglevel=error)
    (cd "$RH_CACHE" && as_app npm run build --silent)
    [[ -f "$RH_CACHE/src/client/hammerhead.min.js" ]] || die "Rammerhead build did not produce src/client/hammerhead.min.js"
    as_app touch "$RH_CACHE/.build-ok"
    ok "Rammerhead built and cached at $RH_CACHE"
else
    ok "Using cached Rammerhead build $RH_CACHE"
fi
as_app mkdir -p "$RELEASE_DIR/vendor"
as_app ln -sfn "$RH_CACHE" "$RELEASE_DIR/vendor/rammerhead"

# --------------------------------------------------- 4. shared files ---
step "4/9 Linking shared config"
as_app ln -sfn "$APP_ENV_FILE" "$RELEASE_DIR/.env"
ok ".env -> $APP_ENV_FILE"

# ------------------------------------------------------------ 5. test ---
step "5/9 Tests"
if [[ "$RUN_TESTS" == "true" && -d "$RELEASE_DIR/test" ]]; then
    # Tests use their own temporary database and never touch shared/data.
    (cd "$RELEASE_DIR" && as_app env ENV_FILE=/dev/null timeout 300 npm test --silent >"$RELEASE_DIR/.test-output.log" 2>&1) || {
        tail -n 40 "$RELEASE_DIR/.test-output.log"
        die "Tests failed - nothing was changed on the live site."
    }
    ok "$(grep -E '^# pass' "$RELEASE_DIR/.test-output.log" | sed 's/^# //') tests passed"
else
    warn "Tests skipped"
fi

# ---------------------------------------------- 6. backup + migrate ---
step "6/9 Database backup + migrations"
DB_FILE="$(app_env DATA_DIR "$SHARED_DIR/data")/portal.db"
if [[ -f "$DB_FILE" ]]; then
    BACKUP="$SHARED_DIR/backups/pre-deploy-${NEW_RELEASE}.db"
    (cd "$RELEASE_DIR" && as_app node src/cli/index.js backup-db "$BACKUP" >/dev/null)
    ok "Backup: $BACKUP"
fi
(cd "$RELEASE_DIR" && as_app node src/cli/index.js migrate)

# ---------------------------------------------------------- 7. switch ---
step "7/9 Switching current -> $NEW_RELEASE"
switch_current "$NEW_RELEASE"
SWITCHED=1
ok "current -> $RELEASE_DIR"

# --------------------------------------------------- 8. reload + check ---
step "8/9 Reloading processes and checking health"
pm2_reload "$NEW_RELEASE"
wait_healthy "$NEW_RELEASE" || die "New release is not healthy."
ok "portal-web and portal-proxy are healthy on $NEW_RELEASE"
history_add deploy "$NEW_RELEASE" success "ref=$REF commit=$SHA previous=${PREVIOUS:-none}"

# The release is live and healthy: from here on nothing may undo it. Cleanup
# problems are reported as warnings only.
trap - EXIT
trap - ERR
set +e

# --------------------------------------------------------- 9. cleanup ---
step "9/9 Cleanup"
# Update the installed portal-* scripts to this commit's version.
if [[ -d "$RELEASE_DIR/.deploy" ]]; then
    rsync -a --delete "$RELEASE_DIR/.deploy/" "$SCRIPTS_DIR/"
    chmod +x "$SCRIPTS_DIR"/*.sh "$SCRIPTS_DIR"/tools/*.sh 2>/dev/null || true
fi
# Keep the newest KEEP_RELEASES releases (+ always current and previous).
mapfile -t ALL < <(ls -1 "$RELEASES_DIR" | sort)
REMOVE_COUNT=$(( ${#ALL[@]} - KEEP_RELEASES ))
for (( i = 0; i < REMOVE_COUNT; i++ )); do
    r="${ALL[$i]}"
    [[ "$r" == "$NEW_RELEASE" || "$r" == "$PREVIOUS" ]] && continue
    rm -rf "${RELEASES_DIR:?}/$r"
    log "Removed old release $r"
done
# Remove Rammerhead builds no release uses any more.
for cache in "$SHARED_DIR"/vendor/rammerhead-*; do
    [[ -d "$cache" ]] || continue
    if ! find "$RELEASES_DIR" -maxdepth 3 -lname "$cache" 2>/dev/null | grep -q .; then
        rm -rf "$cache"
        log "Removed unused engine build $(basename "$cache")"
    fi
done
# Keep the newest KEEP_DB_BACKUPS pre-deploy backups (none exist on a fresh server).
find "$SHARED_DIR/backups" -maxdepth 1 -name 'pre-deploy-*.db' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +$(( KEEP_DB_BACKUPS + 1 )) | cut -d' ' -f2- | xargs -r rm -f

echo
ok "${C_BOLD}Deployed $NEW_RELEASE in $(( $(date +%s) - STARTED ))s${C_RESET}  (previous: ${PREVIOUS:-none})"
echo "    Roll back any time with:  sudo portal-rollback"
