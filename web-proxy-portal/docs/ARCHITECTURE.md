# Architecture

## Components

| Component | Process / file | Listens on | Purpose |
|---|---|---|---|
| nginx | system service | `:80`, `:443`, `:8443` | TLS, HTTP→HTTPS, per-IP rate limits, WebSockets |
| **portal-web** | `app/src/web/server.js` (PM2, cluster mode) | `127.0.0.1:3000` | Login, landing page, admin panel, JSON API |
| **portal-proxy** | `app/src/proxy/server.js` (PM2, fork mode) | `127.0.0.1:8080` + `8081` | Rammerhead engine + our guard, upstream proxies, script injection, jobs |
| SQLite | `shared/data/portal.db` (WAL mode) | — | Users, pools, proxies, sites, scripts, settings, sessions, usage, activity/request/error logs, devices |
| System log files | `shared/logs/app/YYYY-MM-DD.<process>.log` | — | JSON lines from every process (see LOGGING.md) |
| Rammerhead sessions | `shared/data/sessions/*.rhfsession` | — | Per-session cookies/localStorage of the target sites |

Two separate processes keep the admin UI responsive even when the proxy engine
is busy, and a crash or memory restart of the engine never logs anyone out of
the portal.

## Request flow

```
1. User signs in on portal.example.com            -> pp_id (identity JWT) + pp_at (access JWT)
                                                      cookies (host-only, HttpOnly)
2. User types "example.com" or search words   POST /api/portal/browse
   - words -> the configured search engine's results page (opens through the proxy)
   - URL normalized, private/internal addresses rejected (SSRF protection)
   - allowlist checked, max sessions per user checked
   - returns a signed one-time TICKET (2 min, nonce) in a redirect URL
3. Browser -> browse.example.com/__portal/start?t=TICKET
   - ticket verified + nonce stored (replay impossible)
   - pool chosen: user override > matching site > default pool
   - least-loaded healthy proxy of that pool chosen  => sticky for the session
   - Rammerhead session created, our script loader attached, DB row written
   - pp_proxy cookie (proxy JWT, valid until the identity token expires) set
     (host-only, HttpOnly), 302 -> /<sessionId>/https://example.com/
4. Every request to browse.example.com passes the GUARD (src/proxy/guard.js):
   strip IP headers -> auth cookie -> session owner -> IP lock (optional)
   -> sticky upstream -> allowlist -> rate limit / bandwidth cap -> usage counter
5. Rammerhead fetches the site THROUGH the upstream proxy, rewrites HTML/JS/CSS,
   and adds <script src="/__portal/inject.js"> to every page.
```

## Sign-in (JWT)

`app/src/lib/jwt.js` (HS256, no dependencies) and `app/src/lib/authTokens.js`.
Each token kind is signed with its own key derived from `APP_SECRET`, so one kind
can never be used as another. Only the exact `{"alg":"HS256","typ":"JWT"}` header
is accepted; issuer, audience, kind and expiry are checked.

| Token | Cookie | Lifetime | Used for |
|---|---|---|---|
| Identity | `pp_id` | `IDENTITY_TOKEN_TTL_HOURS` (24) | only to obtain access tokens |
| Access | `pp_at` | `ACCESS_TOKEN_TTL_MINUTES` (5) | every portal request |
| Proxy | `pp_proxy` (proxy hostname) | until the identity token expires | every proxied request |

Access token claims: `sub` (user id), `name`, `email`, `role`, `pool`, `rpm`, `bw`
(limits), `tz`, `tv` (token version), `sid` (identity token id), `idx` (identity
expiry) plus `iss`, `aud`, `typ`, `iat`, `nbf`, `exp`, `jti`.

* API call with an expired access token → `401 {code: "access_token_expired"}`; the
  browser calls `POST /api/auth/refresh` (identity token → new access token) and
  retries the call once (`public/js/common.js`). While the user is active, the
  page also renews about a minute before expiry.
* Page navigation with an expired access token → renewed on the server.
* Expired identity token → `401 {code: "identity_expired", username}`: a password
  prompt appears over the current page; signing in again (`continueAs` = same user
  only) continues where the user was. Pages redirect to `/login?expired=1`.
* No valid tokens → `401 {code: "not_signed_in"}` / redirect to `/login`.
* Revocation: tokens carry `tv`; a password change, disabling the user or *sign out
  everywhere* bumps `users.token_version`, checked against a 3-second cache.

## Sticky upstream sessions

* A session gets one upstream proxy at creation (`sessions.proxy_id`) and keeps it
  until it ends. Per-request rotation breaks logins, CSRF tokens and multi-step flows.
* `src/proxy/upstream.js` sets Rammerhead's `overrideExternalProxySettings` on the
  in-memory session at every request (cheap: only recomputed when the proxy changes).
  Proxy credentials are never written into session files.
* **SOCKS5**: hammerhead can only use HTTP proxies, so for each SOCKS5 upstream a
  local HTTP→SOCKS5 bridge is started on `127.0.0.1:<random>` with a random password
  (`src/proxy/socksBridge.js`).
* **Failover** (setting `upstream_failover`, default on): if the session's proxy is
  marked dead, the session moves to another healthy proxy *of the same pool*.
* **No proxy available**: `upstream_fallback=deny` (default) refuses instead of
  leaking the server's own IP. `direct` uses the server IP.

## Proxy health checks

`src/jobs/healthCheck.js` runs every `HEALTHCHECK_INTERVAL_MIN` (default 5) in the
engine's primary process: tunnel through each proxy → HEAD `HEALTHCHECK_URL`.
`healthy` / `slow` (> `HEALTHCHECK_SLOW_MS`, last resort) / `dead` (after
`HEALTHCHECK_FAILURES_BEFORE_DEAD` failures in a row; never assigned). Admins can
also click **Check now**.

## Script injection

Every session's `injectable.scripts` contains `/__portal/inject.js`. Hammerhead
writes that script tag into each proxied HTML page (also iframes). The endpoint
decodes the page's real URL from the `Referer` (un-shuffling Rammerhead's URL
obfuscation) and returns only matching, enabled scripts in load order, each wrapped
in try/catch and scheduled at `document-start` / `document-end` / `document-idle`.
See `app/injected-scripts/README.md`.

## Session lifecycle & resources

* Rammerhead purges sessions idle for `SESSION_IDLE_TIMEOUT_MIN` (60) or older
  than `SESSION_MAX_LIFETIME_HOURS` (24), checked every `SESSION_CLEANUP_INTERVAL_MIN` (15).
* `src/proxy/sessionSync.js` (every 30 s) marks purged sessions as ended in the DB and
  executes "End session" requests from the portal/admin.
* Memory: PM2 `max_memory_restart` (`WEB_MAX_MEMORY`, `PROXY_MAX_MEMORY`) and
  `--max-old-space-size`. With `PROXY_WORKERS>0` each worker also watches its own RSS
  (`PROXY_WORKER_MAX_MEMORY_MB`). Sessions are saved to disk on shutdown, so a restart
  does not log users out of target sites.
* Usage counters are aggregated in memory and flushed to SQLite every 10 s.

## Security model

**Why two hostnames.** Every proxied website runs as JavaScript on the proxy's
origin. If the admin panel lived on the same origin, any proxied site could call the
admin API with the admin's cookies. With `portal.` and `browse.` split, the
sign-in cookies (`pp_id`, `pp_at`) are host-only on the portal, the proxy cookie (`pp_proxy`) is
host-only on the proxy, and browsers' same-origin policy keeps proxied pages away
from the portal. The process refuses to start in production if both are equal.

Other measures:

| Threat | Mitigation |
|---|---|
| Public traffic draining proxy bandwidth | Login required for every proxy request; per-user rpm + daily MB caps; per-IP nginx limits |
| Using someone else's session id | Session owner checked on every request |
| Ticket replay / theft from history | 2-minute expiry, one-time nonce, `Referrer-Policy: no-referrer` on the hand-off |
| CSRF on the portal API | Double-submit token (`pp_csrf` cookie + `X-CSRF-Token` header), SameSite cookies |
| Brute force | 10 failed logins / 15 min / IP in the app + `10r/m` at nginx + fail2ban |
| API abuse | per-user (per-IP when signed out) API rate limit in the app + per-IP nginx limits |
| Forged / swapped tokens | per-kind signing keys, strict header/issuer/audience/expiry checks |
| SSRF to the server / LAN | Private, loopback, link-local and own hostnames rejected as start URLs |
| User IP leaking to target sites | `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-*` stripped before proxying |
| Stolen passwords | scrypt hashes; access codes stored as SHA-256 only, shown once |
| Disabled user keeps access | `token_version` bump invalidates all tokens within ~3 s, sessions ended |
| XSS in the portal | Strict CSP (`script-src 'self'`, no inline), all output escaped |

## Data model (SQLite)

One migration for release 1: `app/src/db/migrations/001_initial_schema.sql` (commented).
Later migrations must stay additive so older releases keep working after a rollback.

**Every table** has:

| Column | Meaning |
|---|---|
| `id` | GUID, UUID v7 (`lib/ids.js`): random but ordered by creation time, so indexes stay compact and *newest first* is `ORDER BY id DESC` |
| `created_at`, `updated_at` | UTC, epoch milliseconds |
| `created_by`, `updated_by` | `users.id` of who did it, `NULL` = system |

`db.insert()` and `db.TOUCH` / `db.touch()` (`src/db/index.js`) fill these from the
request context (`src/lib/context.js`, AsyncLocalStorage): the web server and the
proxy guard set the acting user, request id, IP and device once per request.

Tables: `users`, `proxy_pools`, `pool_access`, `proxies`, `proxy_checks`, `sites`,
`scripts`, `settings`, `sessions` (id = Rammerhead's 32-hex session id),
`used_tickets`, `usage_slots` (15-minute UTC slots), `client_devices`, `events`,
`request_log`, `error_reports`, `server_metrics`, plus `schema_migrations`.

## Time zones

The database stores UTC only. Every API call sends the browser's zone in
`X-Timezone` (downloads use `?tz=`); `req.tz` is used only where a calendar day
matters: "today" counts, per-day charts, the user's daily traffic limit (at the
user's own midnight, from `users.timezone`) and the local-time columns of exports.
Usage is stored in 15-minute UTC slots so it can be regrouped into any zone's days
(also +05:30 / +05:45 zones and DST changes). Pages render times in local time.

## Performance

| Where | What |
|---|---|
| nginx | gzip for text responses (`proxy-portal-gzip.conf`), keep-alive connection pools to Node.js (`upstream ... keepalive`) |
| Node.js | `keepAliveTimeout` 65 s (above nginx's 60 s, avoids 502s on reused sockets) |
| Static files | `/assets/v-<content hash>/...` cached for a year (`immutable`); pages served from memory |
| API | rate limit per user (`API_RATE_LIMIT_RPM`, 600/min) or per IP signed out (`API_RATE_LIMIT_ANON_RPM`, 120/min), writes count 3×, `RateLimit-*` headers, `Retry-After` on 429 |
| Lists | cursor paging: 50 rows per batch, summary of the whole set on the first batch |
| SQLite | prepared-statement cache (LRU 500), 16 MB page cache, mmap, `temp_store=MEMORY`, `PRAGMA optimize` hourly (maintenance job) |
| Caches | users 3 s, sessions 2 s, settings/sites/pools 3 s, dashboard/server-health aggregates 5 s, search suggestions 10 min, devices 10 min |
| Logging | request log and usage written in batches (2 s / 10 s) |
