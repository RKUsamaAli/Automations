# Logging, error reports and activity analysis

**Where logs go:** user and admin *actions*, what users did, and errors are stored in
**SQLite** (searchable in the admin panel, exportable). *System / technical* logs
(start-up, health samples, internal warnings and errors) go to **files**.

| Layer | Where to look | Stored |
|---|---|---|
| **Activity log** - every action: sign-ins, sign-ups, searches, sessions, every admin change (with before/after values), users' own proxy changes, server CLI actions, deploys and rollbacks | Admin → Activity log | `events`, `LOG_RETENTION_DAYS` (30) |
| **Request log** - every page opened through the proxy, portal actions, every failure | Admin → Requests, Sessions → Timeline | `request_log`, `REQUEST_LOG_RETENTION_DAYS` (14) |
| **Server health** - memory, CPU, event-loop lag, traffic, errors, p95 per process per minute; starts, stops, crashes | Admin → Server | `server_metrics`, `METRICS_RETENTION_DAYS` (30) |
| **Error reports** - each failure with the steps before it and a reference for the user | Admin → Errors | `error_reports`, `ERROR_RETENTION_DAYS` (30) |
| **System logs** - process start-up, health samples, warnings, internal errors | files on the server | `shared/logs/app/YYYY-MM-DD.<process>.log`, `LOG_FILE_RETENTION_DAYS` (14) |

Request-log rows are written in batches (every ~2 s), so logging never slows browsing down.

**Every stored row says who, where and on what:** `created_by` (the user), request id,
IP, the **browser/device** (`client_id` → `client_devices`), and the **server**,
**process** (`web:0`, `proxy:2`, `cli`, `deploy` …) and **release**.

### Browser and device details

Each distinct browser/device is stored once in `client_devices` and referenced by
log rows. Sources: the User-Agent and Client Hints headers, plus an `X-Client`
header the portal pages send (JSON: screen, window size, pixel ratio, languages,
time zone, touch, memory, CPU cores, network type). Parsed fields: browser +
version, engine, OS + version, device type (desktop / mobile / tablet / bot) and
model. Proxied requests use the device that started the browsing session (passed in
the hand-off ticket). Shown in Requests, the Activity log (column + details panel),
error reports, and the CSV exports. Kept 180 days after last use.

## 0. Request log and server health

**Request log** (`REQUEST_LOG_LEVEL`):

* `pages` (default): every page a user opened through the proxy (site, status, duration, size,
  **which upstream proxy**), every portal page and API call, and every failed sub-request.
* `all`: also every successful image/script/XHR (much more data; use while debugging a site).
* `off`: failures only.

Admin → **Requests** filters by user (pick from suggestions), type, result and time range; the default "User activity"
view hides the portal's own background reads. **Export CSV** for analysis. Each browsing
session's full page history is in Sessions → **Timeline**.

**Server health** (Admin → **Server**): every process (`web:0`, `web:1`, `proxy`, `proxy:N`
workers) records once a minute: memory (RSS, heap), CPU %, **event-loop lag** (how blocked the
process is), machine load and free memory, requests, errors, p95 response time and active
sessions. The same sample is also written as a JSON `health` line to the process log.
Lifecycle events: `Process started` / `Process stopped` (with uptime and memory) and
**`Process crashed or killed`** - recorded at the next start when the previous instance
disappeared without a clean shutdown (crash, out-of-memory kill, power loss), including its
last health sample. That is usually the explanation for "the server went down at 03:12".

Upstream proxy health checks are kept per proxy: Proxy pools → Proxies → **History**
(latency chart + every check).

## Error reports - principle

When something fails, the steps that led to it are stored with the error, so the failure can
be reproduced and fixed.

## 1. Error reports (Admin → Errors)

Created automatically when:

| Kind | When | User sees |
|---|---|---|
| `page_load_failed` | a page cannot be loaded: upstream proxy down, connection dropped, timeout, DNS, TLS | "This page couldn't load" + **Try again** + reference |
| `upstream_auth_failed` | the upstream proxy rejects its login (HTTP 407) | the site's response |
| `site_error` (warning) | a page answered 5xx through the proxy | the site's error page |
| `server_exception` | a bug in the portal or the proxy engine | "Something went wrong… Reference: E-…" |
| `client_js`, `client_promise`, `api_error`, `network_error` | errors in the browser on portal pages | toast with the reference |

Each report contains:

* **Reference** (`E-7K2P9Q`): shown to the user. Ask users to send it, then search it in Admin → Errors.
* **Steps before the error**, in time order:
  * the user's recent **events**: signed up, signed in, session started (which proxy), …;
  * the **proxy trail** of that browsing session: pages opened, any failed sub-requests, with status and time;
  * the **portal trail**: API calls with status and duration;
  * the **browser trail**: pages viewed and buttons pressed (by label, never typed text).
* **Context:** page/URL, website, upstream proxy (masked) and its health, browsing session, request id, release, client IP and browser, request headers (without cookies/auth), stack trace.
* **Browser and device** (see above) and **server at the time**: server, process, pid, release, Node version, platform, uptime, process memory, machine load and free memory.
* **Grouping:** the same problem for the same user/session within 2 minutes increments ×N instead of creating new reports. "N similar" shows how many reports share the fingerprint. **Resolve all like this** closes the whole group once the bug is fixed.

**Copy as JSON** puts the complete report on the clipboard for a bug ticket.
Reports are kept `ERROR_RETENTION_DAYS` (default 30).

### Privacy

Passwords, tokens, tickets, cookies, `Authorization` headers and proxy credentials are
removed before anything is stored or logged (`src/lib/redact.js`, unit tested).
Browsing-session ids are shortened. Typed input values are never recorded.

## 2. Activity log (Admin → Activity log)

Every action is stored (`src/services/events.js`), from any source:

| Source | Examples |
|---|---|
| Portal (`web`) | sign-up, sign-in, failed sign-in, signed in again after expiry, search, session started/ended, password changed, own proxies added/checked/enabled/removed, API rate limit hit |
| Admin actions | users created/updated/deleted/approved, access codes, sign out everywhere, pools/proxies/sites/scripts created/updated/deleted, settings, proxy checks, errors resolved/reopened |
| Proxy engine (`proxy`) | blocked sites, rate limits, failovers, proxy offline/recovered, session refused |
| Server CLI (`cli`) | admin/user created, password reset, proxies imported, backups (with the server account that ran it) |
| Deploy (`deploy`) | `deploy_success`, `deploy_failed`, `rollback_success`, `rollback_auto`, `rollback_failed` (from `history_add` in the deploy scripts via `portal-cli record-event`) |
| System | process started/stopped/crashed |

Each entry has a level (`info`, `warn`, `error`), a **target** (`user:<id>`,
`pool:<id>`, `site:<id>` …) and, for edits, the **changes** field by field
(`{"role": ["user", "admin"]}`; passwords and access codes are only noted as
*changed*). Filters: event type, source, *Warnings and errors*, user. **Details**
opens a panel with the changes, the device, the server and the request id
(*Find in Requests*). **Export CSV** includes level, source, target, changes, device
and server columns. Kept `LOG_RETENTION_DAYS` (default 30).

Times are stored in UTC; screens show the browser's time zone, and exports add a
`time_local (<zone>)` column next to `time_utc`.

For errors: **Export (JSON Lines)**, one report per line (`jq`, pandas `read_json(lines=True)`).

```bash
# top 10 failing websites in the export
jq -r .dest_host portal-errors-*.jsonl | sort | uniq -c | sort -rn | head
```

## 3. Server logs

System logs (`src/lib/logger.js`) are written by every process to its own daily file,
one JSON object per line:

```
/opt/proxy-portal/shared/logs/app/2026-11-22.web-0.log
/opt/proxy-portal/shared/logs/app/2026-11-22.proxy.log
{"ts":"2026-11-22T15:35:59.979Z","level":"warn","scope":"proxy","msg":"...","server":"vps1","process":"proxy","pid":1234,"release":"20261122_ab12cd3","requestId":"..."}
```

Days are UTC. Files older than `LOG_FILE_RETENTION_DAYS` (14) are deleted by the
hourly maintenance job. `LOG_DIR` overrides the folder.

| File | What |
|---|---|
| `/opt/proxy-portal/shared/logs/app/YYYY-MM-DD.<process>.log` | system logs per process, JSON lines |
| `/opt/proxy-portal/shared/logs/web.{out,err}.log` | portal process (PM2), JSON lines |
| `/opt/proxy-portal/shared/logs/proxy.{out,err}.log` | proxy engine (PM2), JSON lines |
| `/var/log/nginx/proxy-portal-{app,proxy}.access.log` | every request with time and `rid=<request id>` |
| `/opt/proxy-portal/releases.log` | deploy / rollback history |

```bash
sudo portal-logs errors                         # follow only error lines, both processes
sudo portal-logs proxy                          # follow everything from the engine
grep rid=<request id> /var/log/nginx/proxy-portal-*.access.log   # nginx line of a report
jq -c 'select(.ref=="E-7K2P9Q")' /opt/proxy-portal/shared/logs/*.err.log
grep <request id> /opt/proxy-portal/shared/logs/app/*.log          # every process, one request
jq -c 'select(.level=="error")' /opt/proxy-portal/shared/logs/app/$(date -u +%F).*.log
```

The **request id** ties everything together: nginx generates it, the apps log it and
store it on the error report.

Settings (`shared/.env`): `LOG_LEVEL` (debug|info|warn|error), `LOG_FORMAT` (console
format json|text; files are always JSON), `LOG_DIR`, `LOG_FILE_RETENTION_DAYS`,
`LOG_RETENTION_DAYS`, `ERROR_RETENTION_DAYS`, `REQUEST_LOG_RETENTION_DAYS`,
`METRICS_RETENTION_DAYS`.
