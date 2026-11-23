/* Live browser page: shows the server's Chromium (JPEG frames over a
   WebSocket) and sends mouse, touch, wheel and keyboard input back.
   /live?url=<address>  or  /live?q=<words>  opens that first. */
(function () {
    'use strict';
    var P = window.Portal;
    var canvas = P.$('#screen');
    var ctx = canvas.getContext('2d');
    var kbd = P.$('#kbd');
    var addr = P.$('#lb-url');
    var overlay = P.$('#overlay');
    var stage = P.$('.live-stage');
    var ws = null;
    var state = { url: '', title: '', tabs: [] };
    var size = { w: 0, h: 0, dpr: 1 };
    var touchUi = window.matchMedia('(pointer: coarse)').matches;
    var LOOKS_LIKE_URL = /^[a-z][a-z0-9+.-]*:\/\/|^[^\s/?#]+\.[a-z][a-z0-9-]+(?::\d+)?(?:[/?#]\S*)?$|^localhost(?::\d+)?/i;
    var params = new URLSearchParams(location.search);
    var firstOpen = null;
    var retry = 0;
    var failedOpens = 0; // connections that closed before (or right after) opening
    var closedOnPurpose = false;

    function googleUrl(q) { return 'https://www.google.com/search?q=' + encodeURIComponent(q); }
    function target(text) {
        text = String(text || '').trim();
        if (!text) return null;
        if (LOOKS_LIKE_URL.test(text)) return text;
        P.api('POST', '/api/portal/searches', { q: text }).catch(function () {}); // recent searches
        return googleUrl(text);
    }
    if (params.get('q')) firstOpen = target(params.get('q'));
    else if (params.get('url')) firstOpen = params.get('url');
    if (params.get('q') || params.get('url')) history.replaceState(null, '', '/live');

    function show(text, spinner, retryButton) {
        overlay.hidden = !text;
        P.$('#overlay-text').textContent = text || '';
        P.$('.spinner', overlay).style.display = spinner === false ? 'none' : '';
        var b = P.$('#overlay-retry');
        if (retryButton && !b) {
            b = document.createElement('button');
            b.type = 'button';
            b.id = 'overlay-retry';
            b.className = 'primary';
            b.textContent = 'Try again';
            b.addEventListener('click', function () { failedOpens = 0; retry = 0; closedOnPurpose = false; b.remove(); connect(); });
            overlay.appendChild(b);
        } else if (!retryButton && b) b.remove();
    }
    function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

    // --------------------------------------------------------- frames --
    var pending = null;
    var drawing = false;
    function draw() {
        if (!pending || drawing) return;
        var blob = pending;
        pending = null;
        drawing = true;
        createImageBitmap(blob).then(function (img) {
            if (canvas.width !== img.width || canvas.height !== img.height) { canvas.width = img.width; canvas.height = img.height; }
            ctx.drawImage(img, 0, 0);
            img.close && img.close();
            if (!overlay.hidden && P.$('#overlay-text').textContent.indexOf('Starting') === 0) show('');
        }).catch(function () {}).then(function () { drawing = false; if (pending) requestAnimationFrame(draw); });
    }

    // ------------------------------------------------------- connect --
    async function connect() {
        show(retry ? 'Reconnecting…' : 'Starting your browser…');
        var t;
        try {
            t = await P.api('POST', '/api/portal/live/ticket');
        } catch (err) {
            return show(err.message + (err.detail ? ' - ' + err.detail : ''), false, true);
        }
        var gotMessage = false;
        var q = '?t=' + encodeURIComponent(t.ticket);
        if (firstOpen) { q += '&open=nav&url=' + encodeURIComponent(firstOpen); firstOpen = null; }
        ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + t.path + q);
        ws.binaryType = 'blob';
        ws.onopen = function () { retry = 0; measure(true); };
        ws.onmessage = function (e) {
            gotMessage = true;
            if (typeof e.data !== 'string') { pending = e.data; requestAnimationFrame(draw); return; }
            var m;
            try { m = JSON.parse(e.data); } catch (_) { return; }
            if (m.t === 'state') return onState(m);
            if (m.t === 'status') return show(m.state === 'starting' ? 'Starting your browser…' : '');
            if (m.t === 'notice') return m.message && P.toast(m.message, 5000);
            if (m.t === 'focus') return onFocus(m.editable);
            if (m.t === 'dialog') return onDialog(m);
            if (m.t === 'error') { closedOnPurpose = true; show(m.message + (m.detail ? ' (' + m.detail + ')' : ''), false); }
        };
        ws.onclose = function (e) {
            if (closedOnPurpose) return;
            if (e.code === 4000) { show('The browser was closed (' + (e.reason || 'idle') + ').', false, true); return; }
            if (!gotMessage) failedOpens += 1;
            if (failedOpens >= 3) {
                P.reportError('live_connect_failed', 'Live browser connection closed before any data (code ' + e.code + ')', { status: e.code });
                show('Could not connect to the live browser (connection closed, code ' + e.code + '). The server may be blocking WebSockets.', false, true);
                return;
            }
            retry += 1;
            show('Connection lost. Reconnecting…');
            setTimeout(connect, Math.min(10000, 500 * Math.pow(2, Math.min(retry, 5))));
        };
    }

    function onState(m) {
        state = m;
        if (document.activeElement !== addr) addr.value = m.url === 'about:blank' ? '' : m.url;
        document.title = (m.title || 'New tab') + ' · Browser';
        P.$('#lb-tab-count').textContent = String(m.tabs.length);
        var menu = P.$('#lb-tab-menu');
        menu.innerHTML = m.tabs.map(function (t) {
            return '<div class="tab-row' + (t.active ? ' active' : '') + '"><button type="button" role="menuitem" data-tab="' + t.id + '"' + (t.active ? ' aria-current="true"' : '') + '><span class="tab-title">' + P.esc(t.title || t.url || 'New tab') + '</span><span class="muted small tab-url">' + P.esc(t.url === 'about:blank' ? '' : t.url) + '</span></button>' +
                '<button type="button" class="tab-x" data-close="' + t.id + '" aria-label="Close tab ' + P.esc(t.title || t.url) + '">&times;</button></div>';
        }).join('') + '<button type="button" role="menuitem" data-new>+ New tab</button>';
        P.$all('[data-tab]', menu).forEach(function (b) { b.addEventListener('click', function () { send({ t: 'tab', id: Number(b.getAttribute('data-tab')) }); tabs.close(true); }); });
        P.$all('[data-close]', menu).forEach(function (b) { b.addEventListener('click', function () { send({ t: 'closeTab', id: Number(b.getAttribute('data-close')) }); }); });
        P.$('[data-new]', menu).addEventListener('click', function () { send({ t: 'newTab' }); tabs.close(false); addr.value = ''; addr.focus(); });
    }

    // --------------------------------------------------------- sizing --
    var resizeTimer = null;
    function measure(now) {
        var r = stage.getBoundingClientRect();
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        var next = { w: Math.round(r.width), h: Math.round(r.height), dpr: dpr, mobile: touchUi && r.width < 900 };
        if (next.w === size.w && next.h === size.h && next.dpr === size.dpr && !now) return;
        size = next;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { send({ t: now ? 'hello' : 'resize', w: size.w, h: size.h, dpr: size.dpr, mobile: size.mobile }); }, now ? 0 : 200);
    }
    if (window.ResizeObserver) new ResizeObserver(function () { measure(false); }).observe(stage);
    else window.addEventListener('resize', function () { measure(false); });

    /** Page CSS pixels of a pointer event (the canvas is stretched to the stage). */
    function point(e) {
        var r = canvas.getBoundingClientRect();
        return { x: Math.round((e.clientX - r.left) * (size.w / r.width)), y: Math.round((e.clientY - r.top) * (size.h / r.height)) };
    }
    function modsOf(e) { return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey }; }
    function merge(a, b) { for (var k in b) a[k] = b[k]; return a; }

    // ---------------------------------------------------------- mouse --
    var moveQueued = null;
    var touch = null; // { id, x0, y0, x, y, t0, moved }
    function focusKeys() {
        if (!touchUi) kbd.focus({ preventScroll: true });
    }
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        if (e.pointerType === 'touch') {
            if (touch) { touch = null; return; } // second finger: ignore (no pinch yet)
            touch = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: Date.now(), moved: false };
            return;
        }
        canvas.setPointerCapture(e.pointerId);
        focusKeys();
        send(merge({ t: 'mouse', type: 'down', button: e.button, buttons: e.buttons, clicks: e.detail || 1 }, merge(point(e), modsOf(e))));
    });
    canvas.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') {
            if (!touch || touch.id !== e.pointerId) return;
            var dx = e.clientX - touch.x;
            var dy = e.clientY - touch.y;
            if (Math.abs(e.clientX - touch.x0) + Math.abs(e.clientY - touch.y0) > 8) touch.moved = true;
            if (touch.moved) {
                // finger drag scrolls the page
                var p = point(e);
                send({ t: 'wheel', x: p.x, y: p.y, dx: -dx * (size.w / canvas.getBoundingClientRect().width), dy: -dy * (size.h / canvas.getBoundingClientRect().height) });
                touch.x = e.clientX;
                touch.y = e.clientY;
            }
            return;
        }
        var msg = merge({ t: 'mouse', type: 'move', buttons: e.buttons }, merge(point(e), modsOf(e)));
        if (!moveQueued) requestAnimationFrame(function () { send(moveQueued); moveQueued = null; });
        moveQueued = msg;
    });
    canvas.addEventListener('pointerup', function (e) {
        if (e.pointerType === 'touch') {
            if (touch && touch.id === e.pointerId && !touch.moved) {
                // a tap = a click where the finger was
                var p = point(e);
                send(merge({ t: 'mouse', type: 'down', button: 0, buttons: 1, clicks: 1 }, p));
                send(merge({ t: 'mouse', type: 'up', button: 0, buttons: 0, clicks: 1 }, p));
            }
            touch = null;
            return;
        }
        send(merge({ t: 'mouse', type: 'up', button: e.button, buttons: e.buttons, clicks: e.detail || 1 }, merge(point(e), modsOf(e))));
    });
    canvas.addEventListener('pointercancel', function () { touch = null; });
    canvas.addEventListener('wheel', function (e) {
        e.preventDefault();
        var k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? size.h : 1;
        send(merge({ t: 'wheel', dx: e.deltaX * k, dy: e.deltaY * k }, merge(point(e), modsOf(e))));
    }, { passive: false });

    // ------------------------------------------------------- keyboard --
    var SPECIAL = /^(Enter|Backspace|Tab|Escape|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F\d+)$/;
    function keyMsg(type, e, text) {
        return merge({ t: 'key', type: type, key: e.key, code: e.code, keyCode: e.keyCode, text: text }, modsOf(e));
    }
    kbd.addEventListener('keydown', function (e) {
        if (e.isComposing || e.keyCode === 229) return; // phone keyboards / IME: handled by 'input'
        var printable = e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // paste: see 'paste'
        if (printable) { e.preventDefault(); send(keyMsg('down', e, e.key)); return; }
        if (SPECIAL.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) { e.preventDefault(); send(keyMsg('down', e)); }
    });
    kbd.addEventListener('keyup', function (e) {
        if (e.keyCode === 229) return;
        if (e.key && (e.key.length === 1 || SPECIAL.test(e.key) || e.ctrlKey || e.metaKey)) send(keyMsg('up', e));
    });
    kbd.addEventListener('input', function () {
        if (kbd.value) { send({ t: 'text', text: kbd.value }); kbd.value = ''; }
    });
    kbd.addEventListener('paste', function (e) {
        var text = (e.clipboardData || window.clipboardData).getData('text');
        e.preventDefault();
        if (text) send({ t: 'text', text: text });
    });
    function onFocus(editable) {
        // phones: open the keyboard when the website's focus is in a text field
        if (touchUi && editable) kbd.focus({ preventScroll: true });
        if (touchUi && !editable && document.activeElement === kbd) kbd.blur();
    }
    P.$('#lb-kbd').addEventListener('click', function () { kbd.focus({ preventScroll: true }); });
    P.$('#lb-kbd').hidden = !touchUi;

    // ----------------------------------------------------- navigation --
    P.$('#lb-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var url = target(addr.value);
        if (!url) return;
        send({ t: 'nav', url: url });
        addr.blur();
        focusKeys();
    });
    addr.addEventListener('focus', function () { addr.select(); });
    P.$('#lb-back').addEventListener('click', function () { send({ t: 'back' }); });
    P.$('#lb-forward').addEventListener('click', function () { send({ t: 'forward' }); });
    P.$('#lb-reload').addEventListener('click', function () { send({ t: 'reload' }); });
    var tabs = P.popover(P.$('#lb-tabs'), P.$('#lb-tab-menu'));

    // --------------------------------------------------------- dialogs --
    function onDialog(m) {
        var wrap = document.createElement('div');
        wrap.className = 'dialog-backdrop';
        wrap.innerHTML = '<form class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="ld-title" aria-describedby="ld-msg">' +
            '<h2 id="ld-title">' + P.esc(m.type === 'confirm' ? 'The website asks' : m.type === 'prompt' ? 'The website asks for input' : 'Message from the website') + '</h2>' +
            '<p id="ld-msg" class="pre-wrap">' + P.esc(m.message) + '</p>' +
            (m.type === 'prompt' ? '<input id="ld-value" value="' + P.esc(m.value || '') + '">' : '') +
            '<div class="row end">' + (m.type === 'alert' ? '' : '<button type="button" data-no>Cancel</button>') + '<button type="submit" class="primary">OK</button></div></form>';
        document.body.appendChild(wrap);
        var done = function (accept) {
            send({ t: 'dialog', id: m.id, accept: accept, value: P.$('#ld-value', wrap) ? P.$('#ld-value', wrap).value : undefined });
            wrap.remove();
            focusKeys();
        };
        P.$('form', wrap).addEventListener('submit', function (e) { e.preventDefault(); done(true); });
        var no = P.$('[data-no]', wrap);
        if (no) no.addEventListener('click', function () { done(false); });
        (P.$('#ld-value', wrap) || P.$('button.primary', wrap)).focus();
    }

    // ----------------------------------------------------------- start --
    P.loadMe().then(function (me) {
        if (!me.user) { location.href = '/login?next=' + encodeURIComponent('/live'); return; }
        connect();
    }).catch(function (err) { show(err.message, false); });
    window.addEventListener('pagehide', function () { closedOnPurpose = true; if (ws) ws.close(); });
})();
