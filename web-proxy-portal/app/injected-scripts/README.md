# Injected scripts

Custom JavaScript that is added to proxied pages. Scripts are **stored in the
database** and managed from **Admin → Scripts**; the files in `examples/` are
only starting points (load them, disabled, with `sudo portal-cli seed-examples`).

## How injection works

1. Every Rammerhead session is created with one extra entry in its injected
   scripts list: `/__portal/inject.js` (see `src/proxy/routes.js`).
2. Rammerhead's HTML rewriter adds `<script src="/__portal/inject.js">` to every
   proxied HTML page (also inside iframes).
3. That endpoint reads the page's real URL from the `Referer` header and returns
   only the scripts whose **domain patterns** match, sorted by **load order**,
   each wrapped in `try/catch` and scheduled for its **run at** time.

## Writing a script

```js
// window.__portal.page.url  -> "https://www.example.com/account"
// window.__portal.page.host -> "www.example.com"
if (window.__portal.page.host === 'www.example.com') {
    document.title = '[Portal] ' + document.title;
}
```

Rules of thumb:

- **Keep it small.** It runs on every matching page load, on phones too. 200 KB maximum.
- **Use `window.__portal.page`, not `location`.** `location` contains the proxy URL.
- **Prefer `document-end`.** At `document-start` the page body does not exist yet.
- **Guard against running twice** (iframes, SPA navigations): check for an element id first.
- `fetch()` / `XMLHttpRequest` calls work and go through the proxy like the site's own calls.
- A syntax error is rejected when you save. A runtime error is caught and logged to the
  browser console as `[portal script <name>]`, so it never breaks the page.
- If the browser sends no `Referer` (rare), only scripts with domain pattern `*` run.
