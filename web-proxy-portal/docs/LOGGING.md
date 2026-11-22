# Logging, error reports and activity analysis

Four layers, from "what did this user do" to "why did the server struggle":

| Layer | Where to look | Stored |
|---|---|---|
| **Request log** - every page opened through the proxy, portal actions, every failure | Admin → Requests, Sessions → Timeline | `request_log`, `REQUEST_LOG_RETENTION_DAYS` (14) |
| **Server health** - memory, CPU, event-loop lag, traffic, errors, p95 per process per minute; starts, stops, crashes | Admin → Server | `server_metrics`, `METRICS_RETENTION_DAYS` (30) |
| **Error reports** - each failure with the steps before it and a reference for the user | Admin → Errors | `error_reports`, `ERROR_RETENTION_DAYS` (30) |
| **Activity log** - sign-ins, approvals, sessions, proxy changes, admin actions | Admin → Activity log | `events`, `LOG_RETENTION_DAYS` (30) |

All database writes are batched (every ~2 s), so logging never slows browsing down.

## 0. Request log and server health

**Request log** (`REQUEST_LOG_LEVEL`):

* `pages` (default): every page a user opened through the proxy (site, status, duration, size,
  **which upstream proxy**), every portal page and API call, and every failed sub-request.
* `all`: also every successful image/script/XHR (much more data; use while debugging a site).
* `off`: failures only.

Admin → **Requests** filters by user, type, result and time range; the default "User activity"
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
* **Grouping:** the same problem for the same user/session within 2 minutes increments ×N instead of creating new reports. "N similar" shows how many reports share the fingerprint. **Resolve all like this** closes the whole group once the bug is fixed.

**Copy as JSON** puts the complete report on the clipboard for a bug ticket.
Reports are kept `ERROR_RETENTION_DAYS` (default 30).

### Privacy

Passwords, tokens, tickets, cookies, `Authorization` headers and proxy credentials are
removed before anything is stored or logged (`src/lib/redact.js`, unit tested).
Browsing-session ids are shortened. Typed input values are never recorded.

## 2. Activity log (Admin → Activity log)

Every meaningful action: sign-ups, sign-ins and failed sign-ins, approvals,
sessions started/ended (with which proxy), blocked sites, rate limits, proxy
offline/recovered, failovers, admin changes. **Export activity (CSV)** opens in
Excel/Sheets/pandas. Kept `LOG_RETENTION_DAYS` (default 30).

For errors: **Export (JSON Lines)**, one report per line (`jq`, pandas `read_json(lines=True)`).

```bash
# top 10 failing websites in the export
jq -r .dest_host portal-errors-*.jsonl | sort | uniq -c | sort -rn | head
```

## 3. Server logs

| File | What |
|---|---|
| `/opt/proxy-portal/shared/logs/web.{out,err}.log` | portal process (PM2), JSON lines |
| `/opt/proxy-portal/shared/logs/proxy.{out,err}.log` | proxy engine (PM2), JSON lines |
| `/var/log/nginx/proxy-portal-{app,proxy}.access.log` | every request with time and `rid=<request id>` |
| `/opt/proxy-portal/releases.log` | deploy / rollback history |

```bash
sudo portal-logs errors                         # follow only error lines, both processes
sudo portal-logs proxy                          # follow everything from the engine
grep rid=<request id> /var/log/nginx/proxy-portal-*.access.log   # nginx line of a report
jq -c 'select(.ref=="E-7K2P9Q")' /opt/proxy-portal/shared/logs/*.err.log
```

The **request id** ties everything together: nginx generates it, the apps log it and
store it on the error report.

Settings (`shared/.env`): `LOG_LEVEL` (debug|info|warn|error), `LOG_FORMAT` (json|text),
`LOG_RETENTION_DAYS`, `ERROR_RETENTION_DAYS`.
