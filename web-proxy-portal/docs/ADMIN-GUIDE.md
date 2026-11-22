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
| Bandwidth MB per day | 0 (unlimited) | Per user, resets 00:00 UTC |
| Max active sessions | 5 | Per user |
| When no healthy proxy | Refuse | `Connect directly` would use (and expose) the server's IP |
| Failover | on | Move a session to another proxy of its pool if its proxy dies |
| Lock session to IP | off | Breaks phones switching Wi-Fi ↔ 4G/5G |

Changes apply within ~10–15 seconds without restarting anything.

## Scripts

**Scripts → Add script**: name, domain patterns (`*` = all sites), *run at*, load order,
JavaScript. Syntax errors are rejected on save; runtime errors are caught per script.
Use `window.__portal.page.url` / `.host` for the real page address. Examples:
`sudo portal-cli seed-examples` (added disabled). Details: `app/injected-scripts/README.md`.

## Monitoring

* **Dashboard** – active sessions, usable proxies, bandwidth (14 days), recent events
* **Sessions** – who is browsing what, through which proxy; *End* stops a session within 30 s
* **Logs** – usage per user (7 days) and the event log: logins, failed logins, blocked
  domains, rate limits, proxy dead/recovered, failovers, admin changes (kept 30 days)

## Disabling someone

Users → Edit → untick *Enabled*. Their logins and all browsing sessions stop within a few seconds.
