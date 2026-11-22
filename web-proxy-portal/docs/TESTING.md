# Testing

Three layers, all runnable on a laptop or the server.

| Layer | Command (in `app/`) | What it proves | Runs on every deploy |
|---|---|---|---|
| Unit + API | `npm test` | services, security rules, HTTP API, sign-up/approval, pool access, user proxies (35 tests) | yes |
| Real engine | part of `npm test` when Rammerhead is built | hand-off → session → traffic really through the upstream proxy with its credentials, script injection, SSRF block, access control | yes (deploy.sh links the engine first) |
| **Browser journey** | `npm run e2e` | the whole product in Chromium, desktop + iPhone, 17 steps (below) | no (run before releases) |

`deploy.sh` refuses to go live when `npm test` fails.

## Browser journey (Playwright)

`e2e/tests/journey.spec.js` walks the product exactly like people use it:

1. Admin signs in → dashboard
2. Admin creates a shared pool, imports the provider proxy → health check shows **Online**
3. Admin creates a pool **only assigned users** may use
4. Admin adds a site tile and an injected script
5. Visitor signs up on an iPhone: validation → **Request received**
6. Pending account cannot sign in (clear message)
7. Admin sees the pending badge, **approves**, assigns the private pool to the user
8. User signs in → Browse shows exactly the pools they may use
9. Tapping the tile opens the site **through the admin's proxy** (the fake site prints which upstream served it), the injected script ran, the **Portal** button is there
10. User signs in to the site — cookies work through the proxy
11. Portal button → back; session listed → **Resume** (still signed in)
12. User adds **their own proxy** → Online (a broken one shows "Not responding" and is removed)
13. Browsing via **My proxies** really goes through the user's proxy
14. Ending a session kills its link
15. Admin sees sessions, usage, settings
16. Signing out also locks the proxy (old links go to sign-in)
17. Password change: old password rejected, new one works

The outside world is simulated in `e2e/support/fakes.js`: a demo shop
(`shop.localtest`) and two authenticated upstream proxies. Nothing touches the internet.
Screenshots of every screen are written to `e2e/screenshots/` (not committed).

### Local run (starts its own stack)

```bash
cd app
npm install
RAMMERHEAD_DIR=/path/to/built/rammerhead npm run e2e
```

### Against a deployed server

The server's `shared/.env` needs, **on a test server only**:

```
HEALTHCHECK_URL=http://health.localtest/204
ALLOW_PRIVATE_UPSTREAMS=true
```

then from a machine that can reach it (the browser maps `*.localtest` to 127.0.0.1,
so run it on the server itself or adjust `playwright.config.js`):

```bash
sudo portal-cli create-admin e2eadmin 'Some-Password-1'
E2E_APP_URL=http://portal.localtest E2E_PROXY_URL=http://browse.localtest \
E2E_ADMIN_USER=e2eadmin E2E_ADMIN_PASS='Some-Password-1' npm run e2e
```

Every run uses unique names, so it can be repeated against the same server.
