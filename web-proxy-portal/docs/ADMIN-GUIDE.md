# Admin guide

Open `https://portal.example.com/admin` (admins see an **Admin** button on the landing page).

## First-time checklist

1. **Proxy pools → Add pool** (e.g. "US residential", type residential, country US). The first pool becomes the *default*.
2. **Import** your proxies into it. Accepted formats, one per line:
   ```
   http://user:pass@1.2.3.4:8080
   socks5://user:pass@1.2.3.4:1080
   1.2.3.4:8080:user:pass        # Webshare "download list" format
   1.2.3.4:8080                  # no auth
   ```
   A health check starts automatically; statuses become *healthy*, *slow* or *dead*.
3. **Sites → Add site** for each target site: start URL, the domain patterns it uses
   (`*.example.com` covers the apex and all subdomains — include login/CDN domains),
   optional dedicated pool.
4. **Users**: people can **sign up** at `/register`. By default (Settings → Sign-up)
   each new account waits for approval: the Users tab shows a red badge and an
   *Awaiting approval* list with **Approve / Reject**. You can also **Add user** yourself,
   with a password and/or a generated **access code** (sign in with only the code —
   handy for a group). Optional per-user pool and limits.
5. **Settings**: decide on the allowlist and limits.

## Sharing proxies with users

* **Admin pools** have *Who can use this pool*: **All users**, or **Only users I assign**.
  For the latter, click **Users** next to the pool and tick who may use it. Users pick
  from their allowed pools under "Connect through" on the Browse page.
* **Users' own proxies**: under **My proxies** a user can paste their own list
  (e.g. their Webshare proxies). They form a private *personal* pool only that user can
  use (shown as "personal · name" in Proxy pools). Addresses on private networks are
  refused; limit per user in Settings. Turn the feature off with *Users may add their own proxies*.

## How the pool for a session is chosen

1. the pool the user picked on the Browse page (if they may use it)
2. the user's pool set by an admin (Users → Edit → Proxy pool)
3. the pool of the site whose domains match the start URL
4. the default pool
5. the user's own pool

The session then stays on one proxy (sticky) until it ends. If that proxy dies and
*failover* is enabled, it moves to another proxy of the same pool.

## Settings explained

| Setting | Default | Meaning |
|---|---|---|
| Sign-up | approval | open / admin approves each account / closed |
| Users may add their own proxies | on | "My proxies" page; max per user (25) |
| Portal button on proxied pages | on | small "← Portal" pill so iPhone users can get back |
| Domain allowlist | off | Only configured sites + extra domains can be opened |
| Strict allowlist | off | Also block images/scripts from other domains (breaks most sites that use CDNs) |
| Requests per minute | 1200 | Per user. One page load can be 100+ requests |
| Bandwidth MB per day | 0 (unlimited) | Per user, resets at midnight in the user's own time zone |
| Max active sessions | 5 | Per user |
| When no healthy proxy | Refuse | `Connect directly` would use (and expose) the server's IP |
| Failover | on | Move a session to another proxy of its pool if its proxy dies |
| Lock session to IP | off | Breaks phones switching Wi-Fi ↔ 4G/5G |
| Allow browsing without a proxy | On | On: sessions use the server's own internet connection unless the user turns the proxy switch on (Browse page, or "No proxy (direct)" in the top bar). Off: every session must use a proxy |
| Search engine | Google | What words typed in the Browse search box or the top bar search with. Google: results are read by the server's headless browser (through the chosen proxy) and shown as a results page; if Google answers with a CAPTCHA the results come from DuckDuckGo with a note. DuckDuckGo, Bing or Custom (results URL with `{q}`, optional suggestions URL returning OpenSearch JSON). With the allowlist on, add the engine's domain to the extra domains |
| Suggest search terms | on | The address bar asks the engine for suggestions while typing (cached 10 min) |

Changes apply within a few seconds without restarting anything.

## Live browser (default)

Admin → Settings → **How websites are opened**:

- **Live browser** (default): every user gets their own real Chrome on the
  server. The page `/live` shows its screen and sends clicks, typing, scrolling
  and taps to it. Nothing in the website is rewritten, so sites that refuse web
  proxies work normally: Cloudflare "Just a moment…" checks, Google (solve a
  CAPTCHA yourself if one appears), banks and logins. Logins stay between visits
  (each user has a private browser profile on the server).
- **Web proxy**: the earlier mode (pages rewritten, proxies, injected scripts, top bar).

Live browser notes:

- Proxies are not used by the live browser yet: websites see the server's IP.
- Each open browser needs ~250-400 MB RAM. `LIVE_MAX_BROWSERS` (default 2) users
  can have one open at the same time; a browser nobody watched for
  `LIVE_IDLE_MIN` (15) minutes is closed (its logins stay on disk).
- The browser cannot reach the server itself or private networks (blocked).
- Downloads and file uploads are turned off for now.
- Check it: `curl -s 127.0.0.1:3004/healthz` on the server; logs in
  `shared/logs/live.*.log`.

## Top bar on proxied pages

Every page opened through the portal gets a thin bar at the top (users can
collapse it to a small tab, or turn it off on their Account page):

- **Globe** - back to the portal.
- **Search / address field** - shows the page that is open. Type another
  address to go there, or words to search (Google results via the server's
  browser, through the session's proxy). Everything stays in the same session.
- **Connection chip** - status dot, country flag, exit IP and the **local time
  where the connection comes out** (the proxy's time zone, or the server's own
  for "No proxy"). Tap it for location, ISP, speed, score, a *Check* button and
  the list to switch to another proxy or to *No proxy (direct)*.

Check Google search from the server at any time:

```bash
sudo portal-cli test-search "weather madrid"              # no proxy
sudo portal-cli test-search "weather madrid" "My pool"    # through a pool's proxy
```

Google may answer datacenter proxies with a CAPTCHA; the search then falls
back to DuckDuckGo and says so above the results. Residential proxies work best.

## Scripts

**Scripts → Add script**: name, domain patterns (`*` = all sites), *run at*, load order,
JavaScript. Syntax errors are rejected on save; runtime errors are caught per script.
Use `window.__portal.page.url` / `.host` for the real page address. Examples:
`sudo portal-cli seed-examples` (added disabled). Details: `app/injected-scripts/README.md`.

## Monitoring

* **Dashboard** – active sessions, usable proxies, today's traffic, 24-hour chart, recent activity
* **Sessions** – who is browsing what, through which proxy; *Timeline* lists every page; *End* stops a session within 30 s
* **Requests** – what users did (pages, portal actions, failures) with browser/device
* **Errors** – failures with the steps before them (see [LOGGING.md](LOGGING.md))
* **Server** – memory, CPU, event-loop lag and restarts per process
* **Activity log** – every action with who, what changed, device and server; filter by
  event, source, *Warnings and errors* or user; **Details** shows the before/after values

Long lists (Users, pool proxies, Sessions, Requests, Errors, Activity log, a session's
timeline) load 50 rows at a time while you scroll; the summary line above each list
counts the **whole** filtered set. *Load more* does the same from the keyboard.

Search boxes suggest matching users, sites, error references and types as you type
(↑/↓ and Enter to pick). Picking a user filters the list by that user and shows a
removable *User: name ×* chip. Form fields with known answers (country, start URL,
domain patterns) suggest them too; typing anything else still works.

Times are shown in your browser's time zone (shown in the sidebar); exports include
both UTC and local time.

## Signing in

* Signing in issues an **identity token** (24 h, `IDENTITY_TOKEN_TTL_HOURS`) and
  short **access tokens** (5 min, `ACCESS_TOKEN_TTL_MINUTES`) that the browser
  renews silently - users notice nothing.
* When the identity token expires, a *Your session has expired* prompt appears over
  the page; entering the password (or access code) continues exactly where the user
  was. Only the same account can continue; *Sign out* is offered too.

## Theme

The switch in the top bar / admin sidebar / sign-in page chooses **System** (follow
the device), **Light** or **Dark**. The choice is saved per browser.

## Disabling someone

Users → Edit → untick *Enabled*. Their logins and all browsing sessions stop within a few seconds.
