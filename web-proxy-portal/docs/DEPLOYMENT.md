# Deployment guide

## 1. Choose a server

| Use | Size | Notes |
|---|---|---|
| Testing / < 10 concurrent users | 1 vCPU / 512 MB–1 GB (e.g. Lightsail $5) | setup creates a 2 GB swap file and sets smaller memory limits automatically |
| Production, 40+ concurrent users | ≥ 2 vCPU / 4 GB (Hetzner CPX21+, Lightsail 4 GB) | setup enables Rammerhead workers (`PROXY_WORKERS = CPU count`) |

Ubuntu **22.04 or 24.04 LTS**. Open nothing manually; the script configures `ufw`.

## 2. DNS

Create two **A records** pointing at the server IP:

```
portal.example.com   A   203.0.113.10     # login / landing / admin
browse.example.com   A   203.0.113.10     # proxied browsing
```

Cloudflare: either "DNS only" (grey cloud, simplest), or orange cloud with
SSL mode *Full (strict)* — port 8443 is supported by Cloudflare. With the orange
cloud consider `--ssl-mode custom` with a Cloudflare Origin Certificate, and
uncomment the `set_real_ip_from` lines in the nginx config.

## 3. Server setup (once)

```bash
ssh you@server
git clone https://github.com/rkusamaali/automations.git
cd automations/web-proxy-portal/deploy
sudo ./setup-server.sh \
  --app-domain portal.example.com --proxy-domain browse.example.com \
  --email you@example.com \
  --repo git@github.com:rkusamaali/automations.git --branch main
```

It is idempotent: re-running is safe. It performs:

1. apt update/upgrade + packages (git, build-essential, nginx, certbot, ufw, fail2ban, sqlite3 …)
2. timezone, swap file, kernel/file-descriptor tuning
3. Node.js 22 LTS (NodeSource) + PM2
4. user `portal` and `/opt/proxy-portal/{releases,shared,…}`
5. `/opt/proxy-portal/shared/.env` with generated `APP_SECRET`/`DEPLOY_SECRET`, memory limits sized to the RAM
6. read-only GitHub **deploy key** → add the printed key in *GitHub → repo → Settings → Deploy keys*
7. ufw (SSH, 80, 443, 8443), fail2ban (sshd + nginx rate-limit abuse), unattended upgrades
8. nginx + Let's Encrypt certificate for both hostnames (auto-renew + nginx reload hook);
   snippets in `/etc/nginx/snippets/`: TLS, upstream headers, gzip (`proxy-portal-gzip.conf`),
   keep-alive connection pools to Node.js
9. PM2 boot service `pm2-portal`, log rotation (20 MB × 14), daily backup cron (03:17)
10. commands `portal-deploy`, `portal-rollback`, `portal-status`, `portal-backup`,
    `portal-cli`, `portal-restart`, `portal-logs`, `portal-setup`

If DNS was not ready, HTTPS is skipped with a warning. Fix DNS, then `sudo portal-setup --ssl-only`.

Configuration files:

* `/etc/proxy-portal/deploy.env` – repo, branch, domains, SSL mode, releases to keep …
* `/opt/proxy-portal/shared/.env` – application settings and secrets (documented in `app/.env.example`)

Settings worth knowing in `shared/.env`:

| Setting | Default | Meaning |
|---|---|---|
| `IDENTITY_TOKEN_TTL_HOURS` | 24 | sign-in lifetime; after it the user re-enters the password (page stays) |
| `ACCESS_TOKEN_TTL_MINUTES` | 5 | access token lifetime, renewed silently from the identity token |
| `API_RATE_LIMIT_RPM` | 600 | portal API calls per minute per signed-in user (writes count 3×) |
| `API_RATE_LIMIT_ANON_RPM` | 120 | the same per IP when signed out |
| `LOG_FILE_RETENTION_DAYS` | 14 | system log files in `shared/logs/app/` |
| `REQUEST_LOG_LEVEL` | pages | `pages` / `all` / `off` (see LOGGING.md) |

## 4. Deploy

```bash
sudo portal-deploy                    # latest commit of REPO_BRANCH
sudo portal-deploy --ref v1.3.0       # tag, branch or commit
sudo portal-deploy --source ~/automations   # deploy a local checkout (no git fetch)
sudo portal-cli create-admin admin    # first time only
```

What happens (`deploy/deploy.sh`):

```
fetch (git mirror) → releases/20261122153000_ab12cd3/
npm ci (or reuse node_modules if package-lock.json is unchanged)
Rammerhead engine (pinned commit, built once and cached in shared/vendor/)
link .env → npm test (incl. a real-engine end-to-end test)
DB backup (shared/backups/pre-deploy-<release>.db) → migrations
switch `current` symlink (atomic) → PM2 reload
health check: both services must report the NEW release name
  ├─ healthy   → done, old releases pruned (KEEP_RELEASES=5)
  └─ unhealthy → automatic switch back to the previous release
```

Failing tests stop the deploy **before** anything changes on the live site. A failed
release folder is kept with a `.failed` marker for inspection. Only one
deploy/rollback can run at a time (lock file).

Downtime: the portal reloads with zero downtime when `WEB_INSTANCES ≥ 2`; the proxy
engine restarts in ~1–3 s (sessions are saved to disk first, so logins on target sites survive).

## 5. Roll back

```bash
sudo portal-rollback                 # to the release before the current one
sudo portal-rollback --list          # releases + deploy history
sudo portal-rollback --to 20261120101500_9f8e7d6
sudo portal-rollback --to 20261122153000_ab12cd3   # "roll forward" again
sudo portal-rollback --restore-db    # also restore the DB snapshot taken before the current deploy
```

A rollback is a symlink swap + PM2 reload (seconds; nothing is rebuilt) and is
health-checked; if the target is unhealthy it switches back automatically.

**Upgrading a test server from a pre-release build.** Release 1 has a single new
initial schema (`001_initial_schema.sql`: GUID ids, created/updated by on every
table). A database created by an earlier build cannot be migrated to it; remove it
first (test data only):

```bash
sudo -u portal -H "$(command -v pm2 || echo /usr/bin/pm2)" stop all
sudo mkdir -p /opt/proxy-portal/shared/old-db
sudo mv /opt/proxy-portal/shared/data/portal.db* /opt/proxy-portal/shared/old-db/
sudo portal-deploy                       # creates a fresh database
sudo portal-cli create-admin admin
```

**Database and rollbacks.** Migrations must stay additive (new tables, new nullable
columns), so older code works with the newer schema and you normally do *not* need
`--restore-db`. Use it only if a release corrupted data: it replaces the database
with the pre-deploy snapshot (a safety copy of the current DB is saved first) and
anything written since that deploy is lost.

## 6. Deploying from your own script

Deployments are started manually (or by your own script on the server). There is
no CI deploy. Two ways to call it:

```bash
# A) Let portal-deploy fetch from GitHub itself (REPO_URL / REPO_BRANCH in /etc/proxy-portal/deploy.env, default main)
sudo portal-deploy                       # latest commit of the deploy branch
sudo portal-deploy --ref v1.4.0          # a tag, branch or commit

# B) Your script already pulled/merged a checkout -> deploy exactly that code
cd /srv/Automations && git pull --ff-only
sudo portal-deploy --source /srv/Automations
```

Either way you get the same safety net: tests run first, the database is backed
up, the new release is health-checked, and a failed deploy rolls back by itself.
Every deploy, failure and rollback also appears in Admin → Activity log (source *Deploy*).
`portal-deploy` exits non-zero on failure, so your script can stop or alert on it.
To let a non-root deploy user run it, allow only these two commands
(`sudo visudo -f /etc/sudoers.d/portal-deploy`):

```
deployer ALL=(root) NOPASSWD: /usr/local/bin/portal-deploy, /usr/local/bin/portal-rollback
```

## 7. Operations

| Need | Command |
|---|---|
| Overview | `sudo portal-status` |
| Logs | `sudo portal-logs` · `portal-logs proxy` · `portal-logs nginx` · files in `shared/logs/` |
| Change settings in `.env` | edit `/opt/proxy-portal/shared/.env`, then `sudo portal-restart` |
| Change domains | edit `/etc/proxy-portal/deploy.env`, then `sudo portal-setup --ssl-only` |
| Reset admin password | `sudo portal-cli reset-password admin` |
| Backup now | `sudo portal-backup` → `shared/backups/daily-*.tar.gz` (copy off-server!) |
| Upgrade Rammerhead | change `RAMMERHEAD_COMMIT` in `app/rammerhead.lock`, commit, deploy (roll back if needed) |
| Update deploy scripts | automatic: a successful deploy installs that commit's `deploy/` scripts |

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| Deploy fails at "health check" | `sudo portal-logs` — typical: wrong value in `.env`, port in use |
| Certificate request fails | `dig +short portal.example.com` must show the server IP; port 80 reachable |
| "No upstream proxy available" | Admin → Proxy pools: import proxies / *Check now*; or Settings → fallback `direct` |
| Sites load but logins fail | keep `restrict_session_to_ip` off; make sure the pool's proxies are healthy (failover changes IP) |
| Pages blocked "not on the list of allowed sites" | Settings → allowlist; add the site's domains (incl. login/CDN domains) |
| Process restarts often | `pm2 ls` restart count ↑ → raise `PROXY_MAX_MEMORY` or the VPS size |
| iOS Safari shows nothing | must be HTTPS with a valid certificate on both hostnames and port 8443 open |
