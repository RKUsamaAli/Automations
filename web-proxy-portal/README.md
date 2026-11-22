# Web Proxy Portal

A self-hosted, browser-based web proxy portal. It works in iOS Safari and desktop
browsers with no app, extension or device proxy settings. Users sign in, enter a
URL (or tap a site tile) and browse the target site **through a sticky upstream
proxy** (for example Webshare). Admins can inject custom JavaScript into proxied
pages.

**Features:** sign-up with admin approval, sign-in by password or access code,
admin proxy pools shared with everyone or with chosen users, users' own proxies
("My proxies"), sticky upstream per session with health checks and failover,
site tiles, injected scripts, per-user limits, usage logs, admin panel, and
**error reports that record the steps before every failure** (with a reference the
user can quote). Designed
mobile-first for iPhone Safari.

Built on **[Rammerhead](https://github.com/binary-person/rammerhead)**, a server-side
proxy that keeps cookies and sessions on the server. Ships with production
**server setup**, **deploy** (with automatic rollback) and **rollback** scripts for
Ubuntu 22.04 / 24.04.

```
  iPhone / desktop browser
          │  HTTPS
          ▼
  ┌──────────────── nginx (TLS, per-IP rate limits) ───────────────┐
  │ portal.example.com          browse.example.com (:443 + :8443)   │
  └──────┬──────────────────────────────┬──────────────────────────┘
         ▼                              ▼
  portal-web (Express)          portal-proxy (Rammerhead + guard)
  login · landing · admin  ───► auth · allowlist · rate limit · usage
         │      ticket hand-off         │ sticky upstream per session
         ▼                              ▼
     SQLite (shared/data/portal.db)   Upstream pool (HTTP / SOCKS5) ──► target site
```

## Folder structure

```
web-proxy-portal/
├── README.md                ← you are here
├── docs/
│   ├── ARCHITECTURE.md      how it works, security model, request flow
│   ├── DEPLOYMENT.md        server setup, deploy, rollback, CI, troubleshooting
│   ├── ADMIN-GUIDE.md       users, approvals, proxy pools, sites, scripts, settings
│   ├── TESTING.md           unit, real-engine and Playwright browser tests
│   ├── LOGGING.md           error reports with the user's steps, activity log, server logs
├── app/                     the Node.js application
│   ├── src/
│   │   ├── config/          env loading (.env) + validation
│   │   ├── db/              SQLite connection, migrations/*.sql
│   │   ├── lib/             crypto, signed tokens, domain matching, tunnels, rate limiter
│   │   ├── services/        business logic: users, pools, sites, scripts, sessions, usage, settings
│   │   ├── jobs/            proxy health checks, DB maintenance
│   │   ├── web/             PORTAL process: Express server, routes, middleware, public/ (HTML/CSS/JS)
│   │   ├── proxy/           ENGINE process: Rammerhead wiring, guard, upstream, SOCKS bridge, routes
│   │   └── cli/             command line tool (create-admin, import-proxies, backup-db ...)
│   ├── injected-scripts/    example scripts for page injection + how-to
│   ├── test/                unit, HTTP and real-engine end-to-end tests (node:test)
│   ├── e2e/                 Playwright browser journey + fake shop/upstream proxies
│   ├── ecosystem.config.js  PM2 process definition
│   ├── rammerhead.lock      pinned Rammerhead commit
│   └── .env.example         every app setting, documented
└── deploy/                  server scripts (installed as portal-* commands)
    ├── setup-server.sh      one-time provisioning of a fresh VPS
    ├── deploy.sh            new release + health check + auto-rollback
    ├── rollback.sh          go back to any previous release (optionally restore DB)
    ├── status.sh            overview: release, health, PM2, certificate, disk
    ├── backup.sh            daily DB + config backup
    ├── tools/               portal-cli, portal-restart, portal-logs
    ├── lib/common.sh        shared shell helpers
    ├── templates/           nginx configs
    └── config/deploy.env.example
```

## Quick start (production)

You need an Ubuntu 22.04/24.04 VPS and **two DNS names** pointing at it, e.g.
`portal.example.com` and `browse.example.com` (see *Why two hostnames* in
[ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model)).

```bash
# on the server, as a sudo user
git clone https://github.com/rkusamaali/automations.git && cd automations/web-proxy-portal/deploy
sudo ./setup-server.sh --app-domain portal.example.com --proxy-domain browse.example.com \
     --email you@example.com --repo git@github.com:rkusamaali/automations.git --branch main
#   -> prints a deploy key: add it to GitHub (repo Settings -> Deploy keys, read-only)

sudo portal-deploy                       # build + test + go live
sudo portal-cli create-admin admin       # prints the admin password
```

Open `https://portal.example.com/admin`, then go to **Proxy pools → Add pool → Import**
and paste your proxy list.

Day-to-day:

| Task | Command |
|---|---|
| Deploy the latest `main` | `sudo portal-deploy` |
| Deploy a tag / branch / commit | `sudo portal-deploy --ref v1.2.0` |
| Roll back to the previous release | `sudo portal-rollback` |
| Roll back to a specific release | `sudo portal-rollback --list` then `--to <name>` |
| See what's running | `sudo portal-status` |
| Follow logs | `sudo portal-logs` (`web`, `proxy`, `nginx`) |
| Apply `.env` changes | `sudo portal-restart` |

Full details: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Local development

```bash
cd app
npm install
cp .env.example .env        # set APP_SECRET, APP_DOMAIN=localhost, PROXY_DOMAIN=127.0.0.1,
                            # PUBLIC_PROTOCOL=http, DATA_DIR=./data, NODE_ENV=development
npm run migrate
node src/cli/index.js create-admin admin 'devpassword1'
npm run start:web           # http://localhost:3000

# proxy engine (needs Rammerhead):
git clone https://github.com/binary-person/rammerhead.git vendor/rammerhead
(cd vendor/rammerhead && git checkout "$(grep COMMIT= ../../rammerhead.lock | cut -d= -f2)" && npm install && npm run build)
npm run start:proxy         # 127.0.0.1:8080 / 8081
npm test                    # 35 tests; the engine test runs when vendor/rammerhead is built
npm run e2e                 # Playwright browser journey (see docs/TESTING.md)
```
