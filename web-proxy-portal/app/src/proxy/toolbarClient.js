'use strict';
/**
 * Top bar on proxied pages - browser side. Returned as a JS string and placed
 * at the top of /__portal/inject.js for the session's own pages.
 *
 *   [home] [search icon | current address ...... | Go] [● proxy chip v] [^]
 *
 * - The address field shows the page that is open; type another address or
 *   search words and press Go (opens in this session, same connection).
 * - The proxy chip shows the connection (status dot, flag, exit IP or "No
 *   proxy"); its menu shows exit IP / location / ISP / speed and lets you
 *   switch to another proxy or to no proxy.
 * - ^ collapses the bar to a small tab (remembered); the page moves up again.
 * - Closed shadow DOM: the website cannot restyle or read it (TOOLBAR_SHADOW=open
 *   only on test servers, so browser tests can look inside).
 * - Requests use hammerhead's untouched fetch (the page's window.fetch is
 *   rewritten to go to the proxied website).
 */
function toolbarScript(cfg, page) {
    const conf = JSON.stringify({ ...cfg, page: page || null });
    return `(function () {
  'use strict';
  if (window.top !== window || window.__portalBar) return;
  window.__portalBar = true;
  var C = ${conf};
  var H = window['%hammerhead%'];
  var nfetch = (H && H.nativeMethods && H.nativeMethods.fetch) || window.fetch;
  var BAR_H = window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 52 : 46;
  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { 'X-Portal-Bar': C.key } };
    if (body) { body.sid = C.sid; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return nfetch.call(window, C.base + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('Request failed (' + r.status + ')'));
        return d;
      });
    });
  }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function flag(cc) { return cc && /^[A-Za-z]{2}$/.test(cc) ? String.fromCodePoint(127397 + cc.toUpperCase().charCodeAt(0), 127397 + cc.toUpperCase().charCodeAt(1)) : ''; }
  function ms(v) { return v == null ? '' : v >= 1000 ? (Math.round(v / 100) / 10) + ' s' : v + ' ms'; }
  function tone(x) { return !x || x.direct ? 'off' : x.status === 'dead' || x.status === 'disabled' ? 'bad' : x.status === 'slow' || x.status === 'unknown' ? 'warn' : 'ok'; }
  function band(s) { return s == null ? 'none' : s >= 80 ? 'good' : s >= 50 ? 'fair' : 'poor'; }
  // Local time where the connection comes out (proxy exit / the server's internet)
  function clock(tz, withZone) {
    if (!tz) return '';
    try {
      var t = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date());
      return withZone ? t + ' (' + tz.replace(/_/g, ' ') + ')' : t;
    } catch (_) { return ''; }
  }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (_) { return null; } }

  var I = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>'
  };
  var CSS = ':host{all:initial}*{box-sizing:border-box}' +
    '.bar{position:fixed;left:0;right:0;top:0;height:' + BAR_H + 'px;display:flex;align-items:center;gap:8px;padding:0 10px;background:#fff;color:#1b1f24;border-bottom:1px solid #dfe2e7;box-shadow:0 1px 6px rgba(15,20,40,.08);font:13px/1.4 -apple-system,system-ui,"Segoe UI",sans-serif}' +
    '.bar[hidden],.tab[hidden],.menu[hidden],.note[hidden],.filter[hidden],.sec[hidden]{display:none}' +
    'button{font:inherit;color:inherit;cursor:pointer}' +
    '.ib{width:34px;height:34px;flex:none;border:0;border-radius:9px;background:none;display:grid;place-items:center;color:#2453d4}.ib:hover{background:#f1f3f6}.ib svg{width:20px;height:20px}.ib.muted{color:#6b7380}' +
    'form{flex:1;min-width:0;display:flex;align-items:center;height:34px;border:1px solid #cfd4db;border-radius:999px;background:#f6f7f9;padding:0 4px 0 10px}' +
    'form:focus-within{background:#fff;border-color:#2453d4;box-shadow:0 0 0 3px rgba(36,83,212,.15)}form svg{width:16px;height:16px;flex:none;color:#6b7380}' +
    '.addr{flex:1;min-width:0;height:100%;border:0;background:none;outline:none;font:13px/1 -apple-system,system-ui,sans-serif;color:inherit;padding:0 8px}' +
    '.go{height:26px;padding:0 12px;border-radius:999px;border:0;background:#2453d4;color:#fff;font-weight:600}' +
    '.chip{flex:none;display:flex;align-items:center;gap:6px;height:34px;max-width:46vw;padding:0 8px 0 10px;border:1px solid #dfe2e7;border-radius:999px;background:#fff}.chip:hover{background:#f6f7f9}.chip svg{width:14px;height:14px;flex:none}' +
    '.chip .f:empty{display:none}.chip .clk{flex:none;font:12px/1 ui-monospace,Menlo,monospace;color:#6b7380;padding-left:6px;border-left:1px solid #dfe2e7}.chip .clk:empty{display:none}' +
    '.chip .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 12px/1 ui-monospace,Menlo,monospace}' +
    '.d{display:inline-block;width:8px;height:8px;border-radius:50%;background:#9aa5b3;flex:none}.d.ok{background:#16a34a}.d.warn{background:#f59e0b}.d.bad{background:#dc2626}.d.off{background:#9aa5b3}' +
    '.working .chip .d{background:#f59e0b;animation:pp-pulse 1s ease-in-out infinite}@keyframes pp-pulse{50%{opacity:.35}}@keyframes pp-spin{to{transform:rotate(360deg)}}' +
    '.menu{position:fixed;right:8px;top:' + (BAR_H + 6) + 'px;width:min(340px,calc(100vw - 16px));max-height:calc(100vh - ' + (BAR_H + 20) + 'px);overflow:auto;background:#fff;color:#1b1f24;border:1px solid #dfe2e7;border-radius:14px;box-shadow:0 12px 36px rgba(15,20,40,.28);padding:10px;font:13px/1.45 -apple-system,system-ui,"Segoe UI",sans-serif}' +
    '.sec+.sec,.note+.sec{margin-top:10px;padding-top:10px;border-top:1px solid #eef0f3}.h{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7380;margin:0 0 6px;display:flex;justify-content:space-between;align-items:center}' +
    '.conn{display:grid;gap:3px}.row{display:flex;gap:8px;align-items:center}.ip{font:600 15px/1.3 ui-monospace,Menlo,monospace}.muted{color:#6b7380;font-size:12px}.mono{font-family:ui-monospace,Menlo,monospace}' +
    '.list{display:grid;grid-template-columns:minmax(0,1fr);gap:2px}.item{display:flex;gap:8px;align-items:center;width:100%;min-width:0;text-align:left;border:0;background:none;padding:7px 8px;border-radius:8px}' +
    '.item:hover,.item:focus-visible{background:#f3f5f8;outline:none}.item.sel{background:#eef2ff;font-weight:600}.item[disabled]{opacity:.5;cursor:not-allowed}.item .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.score{min-width:28px;text-align:center;font-size:11px;font-weight:600;padding:1px 5px;border-radius:6px;background:#eef0f3;color:#5f6b7a}.score.good{background:#e3f4e5;color:#1f6b25}.score.fair{background:#fff1d6;color:#8a5a00}.score.poor{background:#fde4e4;color:#a32020}' +
    '.sm{height:28px;padding:0 9px;font-size:12px;border:1px solid transparent;border-radius:8px;background:none}.sm:hover{background:#f3f5f8}' +
    '.spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(36,83,212,.25);border-top-color:#2453d4;animation:pp-spin .8s linear infinite;flex:none}' +
    '.note{margin:6px 0 0;padding:8px;border-radius:8px;background:#fde4e4;color:#a32020;font-size:12px}' +
    '.filter{width:100%;height:32px;padding:0 9px;margin-bottom:6px;border:1px solid #dfe2e7;border-radius:8px;background:#fff;outline:none;font:inherit}' +
    '.tab{position:fixed;top:0;right:16px;height:22px;padding:0 10px;border:1px solid #dfe2e7;border-top:0;border-radius:0 0 10px 10px;background:#fff;color:#2453d4;display:flex;align-items:center;gap:6px;box-shadow:0 2px 6px rgba(15,20,40,.12);font:600 12px/1 -apple-system,system-ui,sans-serif}.tab svg{width:14px;height:14px}' +
    '@media (max-width:560px){.bar{gap:4px;padding:0 4px}.chip{padding:0 6px 0 8px;gap:4px}.chip .t{display:none}.chip .clk{border:0;padding:0}.chip.direct .t{display:inline}.go{padding:0 9px}form{padding-left:8px}.addr{padding:0 6px}.ib{width:30px}}' +
    '@media (prefers-color-scheme:dark){.bar,.menu,.tab,.chip{background:#1b1f26;color:#e7eaee;border-color:#2f3540}.chip .clk{border-color:#343b46;color:#9aa5b3}form{background:#14171c;border-color:#343b46}form:focus-within{background:#14171c}.ib:hover,.chip:hover,.item:hover,.item:focus-visible,.sm:hover{background:#262c35}.ib{color:#7da2ff}.item.sel{background:#26304a}.sec+.sec{border-color:#2a2f38}.muted,.h{color:#9aa5b3}.filter{background:#14171c;border-color:#343b46;color:#e7eaee}.score{background:#2a2f38;color:#9aa5b3}.score.good{background:#17361b;color:#7fd487}.score.fair{background:#3a2c0c;color:#ffc766}.score.poor{background:#3d1717;color:#ff8a8a}.go{background:#4c7dff}}';

  function mount() {
    if (!document.documentElement || !document.body) return false;
    var host = document.createElement('portal-toolbar');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;';
    var root = host.attachShadow({ mode: C.shadow === 'open' ? 'open' : 'closed' });
    root.innerHTML = '<style>' + CSS + '</style>' +
      '<div class="bar" role="toolbar" aria-label="Portal toolbar">' +
        '<button type="button" class="ib home-btn" aria-label="Back to portal" title="Back to portal">' + I.home + '</button>' +
        '<form class="go-form" role="search">' + I.search + '<input class="addr" type="search" enterkeyhint="go" placeholder="Search or type a web address" aria-label="Search or type a web address" autocomplete="off" autocapitalize="none" spellcheck="false"><button class="go" type="submit">Go</button></form>' +
        '<button type="button" class="chip" aria-haspopup="dialog" aria-expanded="false" aria-label="Connection and proxy"><span class="d"></span><span class="f"></span><span class="t">…</span><span class="clk" aria-label="Local time of the connection"></span>' + I.down + '</button>' +
        '<button type="button" class="ib muted collapse" aria-label="Hide the bar" title="Hide the bar">' + I.up + '</button>' +
      '</div>' +
      '<button type="button" class="tab" aria-label="Show the portal bar" hidden>' + I.down + 'Portal</button>' +
      '<div class="menu" role="dialog" aria-label="Connection and proxy" hidden>' +
        '<div class="sec"><div class="h"><span>Connection</span><button type="button" class="sm recheck">Check</button></div><div class="conn"></div></div>' +
        '<div class="note" hidden></div>' +
        '<div class="sec proxies"><div class="h"><span>Switch proxy</span></div><input class="filter" type="search" placeholder="Search proxies" aria-label="Search proxies" hidden><div class="list" role="listbox"></div></div>' +
        '<div class="sec"><button type="button" class="sm off">Turn the bar off (Account page turns it on)</button></div>' +
      '</div>';
    document.documentElement.appendChild(host);
    var $ = function (s) { return root.querySelector(s); };
    var bar = $('.bar'), tab = $('.tab'), menu = $('.menu'), chip = $('.chip'), conn = $('.conn'), list = $('.list'), filter = $('.filter'), note = $('.note'), addr = $('.addr');
    var busy = false, state = null;
    var html = document.documentElement;
    var oldMargin = html.style.getPropertyValue('margin-top');

    function setCollapsed(c) {
      bar.hidden = c; tab.hidden = !c;
      if (c) closeMenu();
      // push the page down so the bar does not cover it
      if (c) html.style.setProperty('margin-top', oldMargin || '0px'); else html.style.setProperty('margin-top', BAR_H + 'px', 'important');
      store('__portal_bar_collapsed', c);
    }
    function showError(m) { note.textContent = m || ''; note.hidden = !m; }

    var clockTz = null;
    function tick() { chip.querySelector('.clk').textContent = clock(clockTz); var lt = root.querySelector('.ltime'); if (lt) lt.textContent = clock(clockTz, true); }
    setInterval(tick, 15000);
    function renderChip(c) {
      chip.querySelector('.d').className = 'd ' + tone(c);
      chip.classList.toggle('direct', !!c.direct);
      chip.querySelector('.f').textContent = flag(c.countryCode);
      chip.querySelector('.t').textContent = c.direct ? 'No proxy' : (c.exitIp || c.label);
      chip.title = c.direct ? 'No proxy: the server connection' + (c.exitIp ? ' (' + c.exitIp + ')' : '') : c.label + (c.exitIp ? ' → ' + c.exitIp : '');
      clockTz = c.timeZone || null;
      tick();
    }
    function timeRow(c) { return c.timeZone ? '<div class="muted">Local time <b class="ltime mono"></b></div>' : ''; }
    function renderConn(c, extra) {
      renderChip(c);
      var place = [c.city, c.country].filter(Boolean).join(', ');
      if (c.direct) {
        conn.innerHTML = '<div class="row"><span class="d off"></span><b>No proxy</b>' + (c.exitIp ? '<span class="mono">' + esc(c.exitIp) + '</span>' : '') + '</div>' +
          (place ? '<div>' + flag(c.countryCode) + ' ' + esc(place) + '</div>' : '') + timeRow(c) +
          '<div class="muted">Websites see the server\\'s own internet connection.</div>' + (extra ? '<div class="muted">' + extra + '</div>' : '');
        tick();
        return;
      }
      conn.innerHTML =
        '<div class="row"><span class="d ' + tone(c) + '"></span><span class="ip">' + esc(c.exitIp || 'IP not checked yet') + '</span></div>' +
        (place || c.countryCode ? '<div>' + flag(c.countryCode) + ' ' + esc(place || c.countryCode) + '</div>' : '') +
        (c.isp ? '<div class="muted">' + esc(c.isp) + '</div>' : '') + timeRow(c) +
        '<div class="muted mono">' + esc(c.label) + '</div>' +
        '<div class="muted">' + [c.status === 'healthy' ? 'Online' : c.status === 'slow' ? 'Slow' : c.status === 'dead' ? 'Offline' : 'Not checked', ms(c.latencyMs), c.score != null ? 'score ' + c.score : ''].filter(Boolean).join(' · ') + '</div>' +
        (extra ? '<div class="row muted">' + extra + '</div>' : '');
      tick();
    }
    function renderList() {
      var items = [];
      (state.pools || []).forEach(function (p) { p.proxies.forEach(function (x) { items.push({ x: x, pool: p.name }); }); });
      $('.proxies').hidden = items.length < 2;
      filter.hidden = items.length <= 6;
      list.innerHTML = '';
      items.forEach(function (it) {
        var x = it.x;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'item' + (x.current ? ' sel' : '');
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(!!x.current));
        b.disabled = !x.usable;
        b.dataset.q = (x.label + ' ' + it.pool + ' ' + (x.city || '') + ' ' + (x.countryCode || '') + ' ' + (x.exitIp || '')).toLowerCase();
        b.innerHTML = '<span class="d ' + (x.direct ? 'off' : tone(x)) + '"></span><span class="grow"><span class="mono">' + esc(x.label) + '</span><br><span class="muted">' +
          esc(x.direct ? 'The server\\'s own connection' : [flag(x.countryCode) + ' ' + (x.city || x.countryCode || ''), x.exitIp, it.pool].filter(function (v) { return v && v.trim(); }).join(' · ')) + '</span></span>' +
          (x.direct ? '' : '<span class="score ' + band(x.score) + '" title="' + (x.score == null ? 'Not tested yet' : 'Score ' + x.score + '/100') + '">' + (x.score == null ? '–' : x.score) + '</span>');
        b.addEventListener('click', function (e) { if (e.isTrusted && !busy && !x.current) switchTo(x); });
        list.appendChild(b);
      });
      applyFilter();
    }
    function applyFilter() {
      var q = filter.value.trim().toLowerCase();
      list.querySelectorAll('.item').forEach(function (b) { b.hidden = !!q && b.dataset.q.indexOf(q) === -1; });
    }
    function load() {
      return api('GET', '/__portal/bar/state?sid=' + encodeURIComponent(C.sid)).then(function (d) {
        state = d; renderConn(d.current); renderList(); showError('');
      }).catch(function (e) { showError(e.message); });
    }
    function working(on, text) {
      busy = on;
      bar.classList.toggle('working', on);
      if (on) conn.insertAdjacentHTML('beforeend', '<div class="row muted"><span class="spin"></span>' + esc(text) + '</div>');
    }
    function switchTo(x) {
      working(true, x.direct ? 'Switching to no proxy…' : 'Switching and checking IP…');
      var started = Date.now();
      api('POST', '/__portal/bar/switch', { proxyId: x.id }).then(function (r) {
        renderConn(r.current, 'Reloading the page…');
        setTimeout(function () { location.reload(); }, Math.max(0, 2300 - (Date.now() - started)));
      }).catch(function (e) { working(false); showError(e.message); load(); });
    }
    function openMenu() { menu.hidden = false; chip.setAttribute('aria-expanded', 'true'); load(); }
    function closeMenu() { menu.hidden = true; chip.setAttribute('aria-expanded', 'false'); }

    $('.go-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = addr.value.trim();
      if (!q) return addr.focus();
      api('POST', '/__portal/bar/go', { q: q }).then(function (r) { location.href = C.base + r.location; }).catch(function (err) { openMenu(); showError(err.message); });
    });
    chip.addEventListener('click', function () { if (menu.hidden) openMenu(); else closeMenu(); });
    $('.home-btn').addEventListener('click', function () { location.href = C.portalUrl; });
    $('.collapse').addEventListener('click', function () { setCollapsed(true); });
    tab.addEventListener('click', function () { setCollapsed(false); });
    $('.recheck').addEventListener('click', function () {
      if (busy) return;
      working(true, 'Checking IP…');
      api('POST', '/__portal/bar/check', {}).then(function (r) { working(false); renderConn(r.current, r.check && !r.check.ok ? esc(r.check.error) : ''); })
        .catch(function (e) { working(false); showError(e.message); });
    });
    $('.off').addEventListener('click', function () {
      api('POST', '/__portal/bar/hide', {}).then(function () { html.style.setProperty('margin-top', oldMargin || '0px'); host.remove(); }).catch(function (e) { showError(e.message); });
    });
    filter.addEventListener('input', applyFilter);
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); chip.focus(); } });
    document.addEventListener('pointerdown', function (e) { if (!menu.hidden && e.composedPath().indexOf(host) === -1) closeMenu(); }, true);

    addr.value = (C.page && (C.page.query || C.page.url)) || '';
    setCollapsed(!!store('__portal_bar_collapsed'));
    load();
    return true;
  }
  if (!mount()) document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
`;
}

module.exports = { toolbarScript };
