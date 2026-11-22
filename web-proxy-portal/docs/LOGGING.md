# Logging, error reports and activity analysis

**Principle:** successful activity is not stored in detail. When something fails, the
steps that led to it ARE stored, so the failure can be reproduced and fixed.

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
