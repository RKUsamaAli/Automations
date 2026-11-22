'use strict';
/**
 * Floating toolbar - browser side. Returned as a JS string and placed at the
 * top of /__portal/inject.js for the session's own pages.
 *
 * - A round button (draggable to the left/right edge, position remembered)
 *   with a status dot: green = proxy online, amber = slow / checking, red = problem.
 * - Its panel: address/search bar on top (Go opens it in this session, through
 *   the same proxy), the connection (exit IP, country/city, ISP, speed, score),
 *   the user's other proxies to switch to, Back to portal, Hide toolbar.
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
  function tone(x) { return !x || x.direct ? '' : x.status === 'dead' || x.status === 'disabled' ? 'bad' : x.status === 'slow' || x.status === 'unknown' ? 'warn' : 'ok'; }
  function band(s) { return s == null ? 'none' : s >= 80 ? 'good' : s >= 50 ? 'fair' : 'poor'; }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (_) { return null; } }

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
  var CSS = ':host{all:initial}*{box-sizing:border-box}' +
    '.fab{position:relative;width:46px;height:46px;border-radius:50%;border:0;padding:0;cursor:pointer;touch-action:none;display:grid;place-items:center;color:#fff;background:#2453d4;box-shadow:0 6px 18px rgba(15,20,40,.35);opacity:.92;transition:transform .15s,opacity .15s}' +
    '.fab:hover,.fab[aria-expanded=true],.fab:focus-visible{opacity:1;transform:scale(1.06)}.fab:focus-visible{outline:2px solid #00c2a8;outline-offset:3px}.fab svg{width:22px;height:22px}' +
    '.dot{position:absolute;right:-2px;top:-2px;width:14px;height:14px;border-radius:50%;background:#9aa5b3;border:2px solid #fff}' +
    '.d{display:inline-block;width:8px;height:8px;border-radius:50%;background:#9aa5b3;flex:none}.ok{background:#16a34a!important}.warn{background:#f59e0b!important}.bad{background:#dc2626!important}' +
    '.fab.working .dot{background:#f59e0b;animation:pp-pulse 1s ease-in-out infinite}@keyframes pp-pulse{50%{opacity:.35}}@keyframes pp-spin{to{transform:rotate(360deg)}}' +
    '.panel{position:absolute;right:0;top:54px;width:min(340px,calc(100vw - 24px));max-height:min(78vh,620px);overflow:auto;background:#fff;color:#1b1f24;border:1px solid #dfe2e7;border-radius:14px;box-shadow:0 12px 36px rgba(15,20,40,.28);font:13px/1.45 -apple-system,system-ui,"Segoe UI",sans-serif;padding:10px}' +
    '.panel[hidden]{display:none}' +
    'form{display:flex;gap:6px}input{font:inherit;color:inherit;min-width:0}' +
    '.addr{flex:1;height:36px;padding:0 10px;border:1px solid #cfd4db;border-radius:9px;background:#fff;outline:none}.addr:focus{border-color:#2453d4;box-shadow:0 0 0 3px rgba(36,83,212,.15)}' +
    '.btn{height:36px;padding:0 12px;border-radius:9px;border:1px solid #cfd4db;background:#fff;color:inherit;font:600 13px/1 -apple-system,system-ui,sans-serif;cursor:pointer;white-space:nowrap}.btn:hover{background:#f3f5f8}.primary{background:#2453d4;border-color:#2453d4;color:#fff}.primary:hover{background:#1d46b8}' +
    '.sm{height:28px;padding:0 9px;font-size:12px}.ghost{border-color:transparent;background:none}' +
    '.sec{margin-top:10px;padding-top:10px;border-top:1px solid #eef0f3}.h{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7380;margin:0 0 6px;display:flex;justify-content:space-between;align-items:center}' +
    '.conn{display:grid;gap:3px}.row{display:flex;gap:8px;align-items:center}.ip{font:600 15px/1.3 ui-monospace,Menlo,monospace}.muted{color:#6b7380;font-size:12px}.mono{font-family:ui-monospace,Menlo,monospace}' +
    '.list{display:grid;gap:2px}.item{display:flex;gap:8px;align-items:center;width:100%;text-align:left;border:0;background:none;padding:7px 8px;border-radius:8px;cursor:pointer;font:inherit;color:inherit}' +
    '.item:hover,.item:focus-visible{background:#f3f5f8;outline:none}.item.sel{background:#eef2ff;font-weight:600}.item[disabled]{opacity:.5;cursor:not-allowed}.item .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.score{min-width:28px;text-align:center;font-size:11px;font-weight:600;padding:1px 5px;border-radius:6px;background:#eef0f3;color:#5f6b7a}.score.good{background:#e3f4e5;color:#1f6b25}.score.fair{background:#fff1d6;color:#8a5a00}.score.poor{background:#fde4e4;color:#a32020}' +
    '.spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(36,83,212,.25);border-top-color:#2453d4;animation:pp-spin .8s linear infinite;flex:none}' +
    '.note{margin-top:8px;padding:8px;border-radius:8px;background:#f3f5f8;font-size:12px}.note.err{background:#fde4e4;color:#a32020}.note[hidden],.filter[hidden]{display:none}' +
    '.filter{width:100%;height:32px;padding:0 9px;margin-bottom:6px;border:1px solid #dfe2e7;border-radius:8px;background:#fff;outline:none}' +
    '.foot{display:flex;justify-content:space-between;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid #eef0f3}' +
    '@media (prefers-color-scheme:dark){.panel{background:#1b1f26;color:#e7eaee;border-color:#2f3540}.addr,.btn,.filter{background:#14171c;border-color:#343b46}.btn:hover,.item:hover,.item:focus-visible{background:#262c35}.primary{background:#4c7dff;border-color:#4c7dff}.item.sel{background:#26304a}.sec,.foot{border-color:#2a2f38}.muted,.h{color:#9aa5b3}.note{background:#262c35}.score{background:#2a2f38;color:#9aa5b3}.score.good{background:#17361b;color:#7fd487}.score.fair{background:#3a2c0c;color:#ffc766}.score.poor{background:#3d1717;color:#ff8a8a}.dot{border-color:#1b1f26}}' +
    '@media (pointer:coarse){.item{padding:10px 8px}.addr,.btn{height:40px}}';

  function mount() {
    if (!document.documentElement) return;
    var host = document.createElement('portal-toolbar');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
    var root = host.attachShadow({ mode: C.shadow === 'open' ? 'open' : 'closed' });
    root.innerHTML = '<style>' + CSS + '</style>' +
      '<button class="fab" aria-haspopup="dialog" aria-expanded="false" aria-label="Portal toolbar: address bar and proxy">' + ICON + '<span class="dot"></span></button>' +
      '<div class="panel" role="dialog" aria-label="Portal toolbar" hidden>' +
      '<form class="go"><input class="addr" type="search" enterkeyhint="go" placeholder="Search or type a web address" aria-label="Search or type a web address" autocomplete="off" autocapitalize="none" spellcheck="false"><button class="btn primary" type="submit">Go</button></form>' +
      '<div class="note err" hidden></div>' +
      '<div class="sec"><div class="h"><span>Connection</span><button type="button" class="btn sm ghost recheck">Check</button></div><div class="conn"></div></div>' +
      '<div class="sec proxies" hidden><div class="h"><span>Switch proxy</span></div><input class="filter" type="search" placeholder="Search proxies" aria-label="Search proxies" hidden><div class="list" role="listbox"></div></div>' +
      '<div class="foot"><button type="button" class="btn sm home">← Back to portal</button><button type="button" class="btn sm ghost hide">Hide toolbar</button></div>' +
      '</div>';
    document.documentElement.appendChild(host);
    var $ = function (s) { return root.querySelector(s); };
    var fab = $('.fab'), panel = $('.panel'), dot = $('.dot'), conn = $('.conn'), list = $('.list'), filter = $('.filter'), note = $('.note'), addr = $('.addr');
    var pos = store('__portal_bar_pos') || { side: 'right', top: 78 };
    var busy = false, state = null;

    function place() {
      host.style.top = pos.top + '%';
      host.style.left = pos.side === 'left' ? '12px' : '';
      host.style.right = pos.side === 'right' ? '12px' : '';
      // the panel opens towards the middle of the screen
      panel.style.right = pos.side === 'left' ? 'auto' : '0';
      panel.style.left = pos.side === 'left' ? '0' : 'auto';
      panel.style.top = pos.top > 50 ? 'auto' : '54px';
      panel.style.bottom = pos.top > 50 ? '54px' : 'auto';
    }
    function showError(msg) { note.textContent = msg || ''; note.hidden = !msg; }
    function setDot(x) { dot.className = 'dot ' + tone(x); }

    function renderConn(c, extra) {
      setDot(c);
      if (c.direct) { conn.innerHTML = '<div class="row"><span class="d"></span><b>Direct</b></div><div class="muted">This session uses the server\\'s own IP.</div>'; return; }
      var place = [c.city, c.country].filter(Boolean).join(', ');
      conn.innerHTML =
        '<div class="row"><span class="d ' + tone(c) + '"></span><span class="ip">' + esc(c.exitIp || 'IP not checked yet') + '</span></div>' +
        (place || c.countryCode ? '<div>' + flag(c.countryCode) + ' ' + esc(place || c.countryCode) + '</div>' : '') +
        (c.isp ? '<div class="muted">' + esc(c.isp) + '</div>' : '') +
        '<div class="muted mono">' + esc(c.label) + '</div>' +
        '<div class="muted">' + [c.status === 'healthy' ? 'Online' : c.status === 'slow' ? 'Slow' : c.status === 'dead' ? 'Offline' : 'Not checked', ms(c.latencyMs), c.score != null ? 'score ' + c.score : ''].filter(Boolean).join(' · ') + '</div>' +
        (extra ? '<div class="row muted">' + extra + '</div>' : '');
    }

    function renderList() {
      var items = [];
      (state.pools || []).forEach(function (p) { p.proxies.forEach(function (x) { items.push({ x: x, pool: p.name }); }); });
      var box = $('.proxies');
      box.hidden = items.length < 2;
      filter.hidden = items.length <= 5;
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
        b.innerHTML = '<span class="d ' + tone(x) + '"></span><span class="grow"><span class="mono">' + esc(x.label) + '</span><br><span class="muted">' +
          esc([flag(x.countryCode) + ' ' + (x.city || x.countryCode || ''), x.exitIp, it.pool].filter(function (v) { return v && v.trim(); }).join(' · ')) + '</span></span>' +
          '<span class="score ' + band(x.score) + '" title="' + (x.score == null ? 'Not tested yet' : 'Score ' + x.score + '/100') + '">' + (x.score == null ? '–' : x.score) + '</span>';
        b.addEventListener('click', function (e) { if (e.isTrusted && !busy && !x.current) switchTo(x, b); });
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
        state = d;
        renderConn(d.current);
        renderList();
        showError('');
      }).catch(function (e) { showError(e.message); });
    }

    function working(on, text) {
      busy = on;
      fab.classList.toggle('working', on);
      if (on) conn.insertAdjacentHTML('beforeend', '<div class="row muted wk"><span class="spin"></span>' + esc(text) + '</div>');
    }

    function switchTo(x, b) {
      working(true, 'Switching and checking IP…');
      var started = Date.now();
      api('POST', '/__portal/bar/switch', { proxyId: x.id }).then(function (r) {
        renderConn(r.current, r.check && r.check.ok ? 'New IP ready — reloading the page…' : 'Switched. Reloading the page…');
        // the proxy engine picks up the change within ~2 s: reload after that
        setTimeout(function () { location.reload(); }, Math.max(0, 2300 - (Date.now() - started)));
      }).catch(function (e) { working(false); showError(e.message); load(); });
    }

    $('.go').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = addr.value.trim();
      if (!q) return addr.focus();
      showError('');
      api('POST', '/__portal/bar/go', { q: q }).then(function (r) { location.href = C.base + r.location; }).catch(function (err) { showError(err.message); });
    });
    $('.recheck').addEventListener('click', function () {
      if (busy) return;
      working(true, 'Checking IP…');
      api('POST', '/__portal/bar/check', {}).then(function (r) {
        working(false);
        renderConn(r.current, r.check && !r.check.ok ? esc(r.check.error) : '');
      }).catch(function (e) { working(false); showError(e.message); });
    });
    $('.home').addEventListener('click', function () { location.href = C.portalUrl; });
    $('.hide').addEventListener('click', function () {
      api('POST', '/__portal/bar/hide', {}).then(function () { host.remove(); }).catch(function (e) { showError(e.message); });
    });
    filter.addEventListener('input', applyFilter);

    function open() {
      panel.hidden = false;
      fab.setAttribute('aria-expanded', 'true');
      if (!addr.value && C.page && C.page.url) addr.value = C.page.url;
      load();
      setTimeout(function () { addr.focus(); addr.select(); }, 0);
    }
    function close() { panel.hidden = true; fab.setAttribute('aria-expanded', 'false'); }

    // drag to the left/right edge (position remembered); a click opens the panel
    var drag = null;
    fab.addEventListener('pointerdown', function (e) { if (!e.isTrusted || e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, moved: false }; fab.setPointerCapture(e.pointerId); });
    fab.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) return;
      drag.moved = true;
      close();
      pos = { side: e.clientX < window.innerWidth / 2 ? 'left' : 'right', top: Math.min(92, Math.max(6, Math.round(e.clientY / window.innerHeight * 100))) };
      place();
    });
    fab.addEventListener('pointerup', function (e) {
      if (!drag) return;
      var moved = drag.moved;
      drag = null;
      if (!e.isTrusted) return;
      if (moved) store('__portal_bar_pos', pos);
      else if (panel.hidden) open(); else close();
    });
    fab.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (panel.hidden) open(); else close(); } });
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape') { close(); fab.focus(); } });
    document.addEventListener('pointerdown', function (e) { if (!panel.hidden && e.composedPath().indexOf(host) === -1) close(); }, true);

    place();
    // status dot straight away (cheap call), panel content on open
    load();
  }
  if (document.documentElement) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
`;
}

module.exports = { toolbarScript };
