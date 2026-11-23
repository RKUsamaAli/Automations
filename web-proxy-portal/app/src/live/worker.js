'use strict';
/**
 * LIVE BROWSER process (PM2 app "portal-live") - a real Chromium on the
 * server, shown in the user's web page and controlled from it.
 *
 * Why: some sites (Cloudflare checks, Google, banks) refuse pages whose
 * scripts were rewritten by a web proxy. Here nothing is rewritten: the
 * site talks to a normal Chrome; the user sees its screen and clicks/types.
 *
 *   browser page /live  --WebSocket-->  portal-web (/live/ws, forwards)  -->  this process
 *     <- JPEG frames of the screen (CDP screencast)
 *     -> mouse, wheel, keys, text, navigation, tabs
 *
 * One Chromium per user (persistent profile: logins and cookies stay),
 * started on demand, closed after LIVE_IDLE_MIN minutes with nobody watching.
 * Headed Chromium on a virtual screen (Xvfb) when installed - closest to a
 * real desktop Chrome - otherwise headless.
 *
 * All traffic goes through the egress guard (egress.js): no private addresses.
 *
 * Env: LIVE_PORT (3004), LIVE_MAX_BROWSERS (2), LIVE_IDLE_MIN (15),
 *      LIVE_QUALITY (JPEG 1-100, 70), LIVE_HEADED (auto|true|false),
 *      LIVE_PROFILES_DIR (DATA_DIR/live-profiles)
 *
 * Run:  node src/live/worker.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');
const config = require('../config');
const { verify } = require('../lib/crypto');
const system = require('../lib/system');
const log = require('../lib/logger')('live');

const PORT = Number(process.env.LIVE_PORT) || 3004;
const MAX_BROWSERS = Math.max(1, Number(process.env.LIVE_MAX_BROWSERS) || 2);
const IDLE_MS = (Number(process.env.LIVE_IDLE_MIN) || 15) * 60000;
const QUALITY = Math.min(95, Math.max(20, Number(process.env.LIVE_QUALITY) || 65)); // best JPEG quality (lowered automatically on slow links)
const MIN_QUALITY = 30;
const MAX_DPR = Math.min(2, Math.max(1, Number(process.env.LIVE_MAX_DPR) || 1)); // 1 = CSS pixels (4x less data than a 2x screen)
const IN_FLIGHT = 2; // frames on their way to a viewer before newer ones replace older ones
const PROFILES = () => process.env.LIVE_PROFILES_DIR || path.join(config.paths.dataDir, 'live-profiles');
const TICKET_PURPOSE = 'live-ticket';

const MOBILE_UA = (v) => `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Mobile Safari/537.36`;
const DESKTOP_UA = (v) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;

// ------------------------------------------------------------ display ----
let display = null;
function ensureDisplay() {
    const mode = String(process.env.LIVE_HEADED || 'auto');
    if (mode === 'false') return null;
    if (process.env.DISPLAY) return process.env.DISPLAY;
    if (display) return display;
    let xvfb = null;
    try {
        xvfb = execFileSync('sh', ['-c', 'command -v Xvfb'], { encoding: 'utf8' }).trim();
    } catch (_) {
        /* not installed */
    }
    if (!xvfb) {
        if (mode === 'true') log.warn('LIVE_HEADED=true but Xvfb is not installed: running headless');
        return null;
    }
    const num = 90 + (process.pid % 9);
    const child = spawn(xvfb, [`:${num}`, '-screen', '0', '1920x1200x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
    child.on('exit', (code) => {
        log.warn(`Xvfb exited (${code})`);
        display = null;
    });
    process.on('exit', () => child.kill());
    display = `:${num}`;
    log.info(`virtual screen ${display} started`);
    return display;
}

// ------------------------------------------------------------- egress ----
let egressPromise = null;
const egress = () =>
    (egressPromise = egressPromise || require('./egress').start({ onBlocked: (host, reason) => log.warn('blocked request from the live browser', { host, reason }) }));

// ----------------------------------------------------------- browsers ----
/** userId -> UserBrowser */
const browsers = new Map();

class UserBrowser {
    constructor(user) {
        this.user = user; // { id, name }
        this.viewers = new Set();
        this.tabs = []; // [{ id, page, cdp }]
        this.active = null;
        this.size = { w: 1280, h: 800, dpr: 1, mobile: false };
        this.lastSeen = Date.now();
        this.startedAt = Date.now();
        this.nextTab = 1;
    }

    async start() {
        const { chromium } = require('playwright-core');
        const { port } = await egress();
        const dir = path.join(PROFILES(), this.user.id.replace(/[^a-zA-Z0-9-]/g, ''));
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const disp = ensureDisplay();
        this.context = await chromium.launchPersistentContext(dir, {
            headless: !disp,
            env: disp ? { ...process.env, DISPLAY: disp } : process.env,
            executablePath: process.env.CHROMIUM_PATH || undefined,
            chromiumSandbox: false,
            viewport: null, // sizes come from the viewer (CDP device metrics)
            proxy: { server: `http://127.0.0.1:${port}`, bypass: '<-loopback>' },
            acceptDownloads: false,
            ignoreHTTPSErrors: process.env.LIVE_IGNORE_TLS_ERRORS === 'true', // test machines behind an intercepting proxy only
            args: ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,MediaRouter', '--window-size=1920,1200', '--window-position=0,0', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
        });
        this.context.on('page', (page) => this.addTab(page, true));
        this.context.on('close', () => this.closed('browser closed'));
        const pages = this.context.pages();
        for (const p of pages) await this.addTab(p, false);
        if (!this.tabs.length) await this.addTab(await this.context.newPage(), true);
        else await this.activate(this.tabs[this.tabs.length - 1].id);
        log.info('live browser started', { user: this.user.name, headed: !!disp });
        require('../services/events').record('live_browser_started', { userId: this.user.id, detail: disp ? 'headed (virtual screen)' : 'headless' });
    }

    chromeMajor() {
        return this.major || '140';
    }

    async addTab(page, makeActive) {
        if (this.tabs.find((t) => t.page === page)) return;
        const tab = { id: this.nextTab++, page, cdp: null };
        this.tabs.push(tab);
        page.on('close', () => this.removeTab(tab));
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                this.sendState();
                if (tab === this.active) this.recordNav(page.url());
            }
        });
        page.on('load', () => this.sendState());
        page.on('domcontentloaded', () => this.sendState());
        page.on('dialog', (d) => this.onDialog(tab, d));
        page.on('filechooser', () => this.notice('Uploading files is not supported in the live browser yet.'));
        page.on('download', () => this.notice('Downloads are turned off in the live browser.'));
        if (makeActive) await this.activate(tab.id);
        else this.sendState();
    }

    async removeTab(tab) {
        this.tabs = this.tabs.filter((t) => t !== tab);
        if (this.active === tab) {
            this.active = null;
            if (this.tabs.length) await this.activate(this.tabs[this.tabs.length - 1].id).catch(() => {});
            else if (this.context && !this.closing) {
                const p = await this.context.newPage().catch(() => null);
                if (p) await this.addTab(p, true).catch(() => {});
            }
        }
        this.sendState();
    }

    async activate(id) {
        const tab = this.tabs.find((t) => t.id === Number(id));
        if (!tab) return;
        if (this.active && this.active !== tab && this.active.cdp) {
            await this.active.cdp.send('Page.stopScreencast').catch(() => {});
        }
        this.active = tab;
        await tab.page.bringToFront().catch(() => {});
        if (!tab.cdp) {
            tab.cdp = await this.context.newCDPSession(tab.page);
            tab.cdp.on('Page.screencastFrame', (f) => this.onFrame(tab, f));
            if (!this.major) {
                const v = await tab.cdp.send('Browser.getVersion').catch(() => null);
                this.major = v && /\/(\d+)\./.test(v.product) ? /\/(\d+)\./.exec(v.product)[1] : null;
                this.fullVersion = v && /\/([\d.]+)/.test(v.product) ? /\/([\d.]+)/.exec(v.product)[1] : null;
                this.realUa = v ? v.userAgent : null;
            }
        }
        await this.applySize(tab);
        await this.startCast(tab);
        this.sendState();
    }

    async applySize(tab) {
        const { w, h, dpr, mobile } = this.size;
        const cdp = tab.cdp;
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile, screenWidth: w, screenHeight: h }).catch(() => {});
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 }).catch(() => {});
        // Identity: the user-agent string AND the client hints (Sec-CH-UA-*) must agree,
        // or bot checks (Cloudflare ...) flag the browser. Desktop: the real Chrome on
        // Linux as it is (only "HeadlessChrome" -> "Chrome" when headless). Phones: a
        // consistent Android identity.
        const major = this.chromeMajor();
        const full = this.fullVersion || `${major}.0.0.0`;
        const brands = [{ brand: 'Chromium', version: major }, { brand: 'Not.A/Brand', version: '99' }];
        const fullVersionList = [{ brand: 'Chromium', version: full }, { brand: 'Not.A/Brand', version: '99.0.0.0' }];
        if (mobile) {
            await cdp.send('Emulation.setUserAgentOverride', {
                userAgent: MOBILE_UA(major),
                platform: 'Linux armv8l',
                userAgentMetadata: { brands, fullVersionList, fullVersion: full, platform: 'Android', platformVersion: '14.0.0', architecture: '', model: 'Pixel 8', mobile: true, bitness: '', wow64: false }
            }).catch(() => {});
        } else {
            const real = this.realUa || DESKTOP_UA(major);
            await cdp.send('Emulation.setUserAgentOverride', {
                userAgent: real.replace('HeadlessChrome', 'Chrome'),
                platform: 'Linux x86_64',
                userAgentMetadata: { brands, fullVersionList, fullVersion: full, platform: 'Linux', platformVersion: '6.8.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false }
            }).catch(() => {});
        }
    }

    async startCast(tab) {
        const { w, h, dpr } = this.size;
        if (!this.quality) this.quality = QUALITY;
        await tab.cdp.send('Page.stopScreencast').catch(() => {});
        await tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.quality, maxWidth: Math.round(w * dpr), maxHeight: Math.round(h * dpr), everyNthFrame: 1 }).catch((e) => log.warn('screencast failed', { error: e.message }));
    }

    /**
     * Frames: never queue. Each viewer has at most IN_FLIGHT frames on the way
     * (the page acks each one it has drawn); a newer frame replaces one that
     * is still waiting, so the picture is always the latest, never seconds old.
     */
    onFrame(tab, f) {
        tab.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
        if (tab !== this.active) return;
        const buf = Buffer.from(f.data, 'base64');
        this.lastFrame = buf;
        for (const ws of this.viewers) {
            const v = ws.__live;
            if (ws.readyState !== 1 || !v) continue;
            if (v.inFlight < IN_FLIGHT) this.push(ws, buf);
            else {
                if (v.pending) this.dropped += 1;
                v.pending = buf;
            }
        }
        this.tune();
    }

    push(ws, buf) {
        ws.__live.inFlight += 1;
        ws.__live.sentAt = Date.now();
        ws.send(buf, { binary: true });
    }

    /** The page drew a frame: send the newest waiting one. */
    ack(ws) {
        const v = ws.__live;
        if (!v) return;
        v.inFlight = Math.max(0, v.inFlight - 1);
        if (v.pending && ws.readyState === 1) {
            const buf = v.pending;
            v.pending = null;
            this.push(ws, buf);
        }
    }

    /** Slow link (many frames replaced) -> lower JPEG quality; smooth again -> back up. */
    tune() {
        const now = Date.now();
        if (!this.tuneAt) this.tuneAt = now;
        if (now - this.tuneAt < 2500) return;
        const dropped = this.dropped || 0;
        this.dropped = 0;
        this.tuneAt = now;
        const q = this.quality || QUALITY;
        let next = q;
        if (dropped > 8 && q > MIN_QUALITY) next = Math.max(MIN_QUALITY, q - 15);
        else if (dropped === 0 && q < QUALITY) this.calm = (this.calm || 0) + 1;
        if (dropped) this.calm = 0;
        if (this.calm >= 3 && q < QUALITY) {
            next = Math.min(QUALITY, q + 10);
            this.calm = 0;
        }
        if (next !== q && this.active) {
            this.quality = next;
            this.startCast(this.active);
        }
    }

    async resize(size) {
        const w = Math.min(2560, Math.max(320, Math.round(Number(size.w) || 0)));
        const h = Math.min(2560, Math.max(320, Math.round(Number(size.h) || 0)));
        const dpr = Math.min(MAX_DPR, Math.max(1, Number(size.dpr) || 1));
        const mobile = !!size.mobile;
        const same = this.size.w === w && this.size.h === h && this.size.dpr === dpr && this.size.mobile === mobile;
        this.size = { w, h, dpr, mobile };
        if (!same && this.active) {
            for (const t of this.tabs) if (t.cdp) await this.applySize(t);
            await this.startCast(this.active);
        }
    }

    state() {
        const t = this.active;
        return {
            t: 'state',
            url: t ? t.page.url() : '',
            title: '',
            tabs: this.tabs.map((x) => ({ id: x.id, url: x.page.url(), active: x === t })),
            size: this.size
        };
    }

    sendState() {
        if (!this.viewers.size || this.closing) return;
        clearTimeout(this.stateTimer);
        this.stateTimer = setTimeout(async () => {
            const s = this.state();
            const t = this.active;
            if (t) {
                s.title = await t.page.title().catch(() => '');
                for (const tab of s.tabs) {
                    const x = this.tabs.find((y) => y.id === tab.id);
                    tab.title = x === t ? s.title : x ? await x.page.title().catch(() => '') : '';
                }
            }
            this.broadcast(s);
        }, 60);
    }

    broadcast(msg) {
        const data = JSON.stringify(msg);
        for (const ws of this.viewers) if (ws.readyState === 1) ws.send(data);
    }

    notice(message) {
        this.broadcast({ t: 'notice', message });
    }

    recordNav(url) {
        if (!/^https?:/i.test(url)) return;
        try {
            const host = new URL(url).hostname;
            require('../services/requestLog').add({ source: 'live', kind: 'page', userId: this.user.id, method: 'GET', url, host, status: 200 });
        } catch (_) {
            /* ignore */
        }
    }

    onDialog(tab, d) {
        const id = Math.random().toString(36).slice(2);
        this.pendingDialog = { id, d };
        this.broadcast({ t: 'dialog', id, type: d.type(), message: d.message().slice(0, 2000), value: d.defaultValue() });
        setTimeout(() => {
            if (this.pendingDialog && this.pendingDialog.id === id) {
                this.pendingDialog = null;
                d.dismiss().catch(() => {});
            }
        }, 60000).unref();
    }

    // -------------------------------------------------------- input --
    async input(msg) {
        this.lastSeen = Date.now();
        const tab = this.active;
        const cdp = tab && tab.cdp;
        const page = tab && tab.page;
        switch (msg.t) {
            case 'hello':
            case 'resize':
                return this.resize(msg);
            case 'nav': {
                const url = normalize(msg.url);
                if (!url) return this.notice('That is not a web address.');
                return page.goto(url, { waitUntil: 'commit', timeout: 30000 }).catch((e) => this.notice(friendlyNavError(e)));
            }
            case 'back':
                return page.goBack({ waitUntil: 'commit', timeout: 15000 }).catch(() => {});
            case 'forward':
                return page.goForward({ waitUntil: 'commit', timeout: 15000 }).catch(() => {});
            case 'reload':
                return page.reload({ waitUntil: 'commit', timeout: 30000 }).catch(() => {});
            case 'stop':
                return cdp.send('Page.stopLoading').catch(() => {});
            case 'tab':
                return this.activate(msg.id);
            case 'newTab': {
                const p = await this.context.newPage();
                if (msg.url && normalize(msg.url)) await p.goto(normalize(msg.url), { waitUntil: 'commit' }).catch(() => {});
                return;
            }
            case 'closeTab': {
                const t = this.tabs.find((x) => x.id === Number(msg.id));
                if (t) await t.page.close().catch(() => {});
                return;
            }
            case 'mouse': {
                const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[msg.type];
                if (!type) return;
                await cdp.send('Input.dispatchMouseEvent', {
                    type,
                    x: num(msg.x),
                    y: num(msg.y),
                    button: msg.type === 'move' ? (msg.buttons ? 'left' : 'none') : ['left', 'middle', 'right'][msg.button] || 'left',
                    buttons: msg.buttons || 0,
                    clickCount: msg.type === 'move' ? 0 : Math.min(3, msg.clicks || 1),
                    modifiers: mods(msg)
                }).catch(() => {});
                if (msg.type === 'up') this.reportFocus(page);
                if (msg.type === 'move' && !msg.buttons) this.reportCursor(page, num(msg.x), num(msg.y));
                return;
            }
            case 'tap': {
                // phones: a tap is a touch start + end (sites with touch handlers) at one point
                const pt = [{ x: num(msg.x), y: num(msg.y), radiusX: 4, radiusY: 4, force: 1, id: 1 }];
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt }).catch(() => {});
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {});
                this.reportFocus(page);
                return;
            }
            case 'wheel':
                return cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: num(msg.x), y: num(msg.y), deltaX: num(msg.dx), deltaY: num(msg.dy), modifiers: mods(msg) }).catch(() => {});
            case 'key': {
                const base = { key: String(msg.key || '').slice(0, 32), code: String(msg.code || '').slice(0, 32), windowsVirtualKeyCode: num(msg.keyCode), nativeVirtualKeyCode: num(msg.keyCode), modifiers: mods(msg) };
                if (msg.type === 'down') {
                    // Enter carries "\r" like a real keyboard (that is what submits forms)
                    const text = base.key === 'Enter' ? '\r' : typeof msg.text === 'string' && msg.text.length === 1 && !(msg.ctrl || msg.meta) ? msg.text : undefined;
                    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, ...base }).catch(() => {});
                    // shortcuts the page cannot see (select all / copy / paste ...)
                    if ((msg.ctrl || msg.meta) && /^[acvxz]$/i.test(base.key)) {
                        const cmd = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' }[base.key.toLowerCase()];
                        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, commands: [cmd] }).catch(() => {});
                    }
                } else {
                    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }).catch(() => {});
                }
                return;
            }
            case 'text':
                return cdp.send('Input.insertText', { text: String(msg.text || '').slice(0, 5000) }).catch(() => {});
            case 'dialog': {
                const p = this.pendingDialog;
                if (!p || p.id !== msg.id) return;
                this.pendingDialog = null;
                return msg.accept ? p.d.accept(typeof msg.value === 'string' ? msg.value.slice(0, 2000) : undefined).catch(() => {}) : p.d.dismiss().catch(() => {});
            }
            default:
        }
    }

    /** The mouse pointer the site shows there (link hand, text I-beam ...), at most ~8 times a second. */
    reportCursor(page, x, y) {
        this.cursorAt = { x, y };
        if (this.cursorTimer) return;
        this.cursorTimer = setTimeout(async () => {
            this.cursorTimer = null;
            const p = this.cursorAt;
            const cursor = await page
                .evaluate(
                    ([px, py]) => {
                        let el = document.elementFromPoint(px, py);
                        while (el && el.shadowRoot) {
                            const inner = el.shadowRoot.elementFromPoint(px, py);
                            if (!inner || inner === el) break;
                            el = inner;
                        }
                        if (!el) return 'default';
                        const c = getComputedStyle(el).cursor;
                        if (c && c !== 'auto') return c;
                        if (el.closest('a[href],button,[role=button],label,summary,select')) return 'pointer';
                        if (el.closest('input,textarea,[contenteditable=""],[contenteditable=true]')) return 'text';
                        return 'default';
                    },
                    [p.x, p.y]
                )
                .catch(() => null);
            if (cursor && cursor !== this.cursor) {
                this.cursor = cursor;
                this.broadcast({ t: 'cursor', value: cursor });
            }
        }, 120);
    }

    /** After a click/tap: is the focus in a text field? (phones open their keyboard) */
    reportFocus(page) {
        clearTimeout(this.focusTimer);
        this.focusTimer = setTimeout(async () => {
            const editable = await page
                .evaluate(() => {
                    let el = document.activeElement;
                    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
                    if (!el) return false;
                    if (el.isContentEditable) return true;
                    const tag = el.tagName;
                    if (tag === 'TEXTAREA') return true;
                    if (tag !== 'INPUT') return false;
                    return !/^(button|checkbox|radio|submit|reset|file|image|range|color|hidden)$/i.test(el.type);
                })
                .catch(() => false);
            this.broadcast({ t: 'focus', editable });
        }, 120);
    }

    // ----------------------------------------------------- viewers --
    attach(ws) {
        ws.__live = { inFlight: 0, pending: null };
        this.viewers.add(ws);
        this.lastSeen = Date.now();
        if (this.lastFrame) this.push(ws, this.lastFrame);
        this.sendState();
    }

    detach(ws) {
        this.viewers.delete(ws);
        this.lastSeen = Date.now();
    }

    async close(reason) {
        if (this.closing) return;
        this.closing = true;
        browsers.delete(this.user.id);
        for (const ws of this.viewers) ws.close(4000, reason.slice(0, 100));
        await this.context.close().catch(() => {});
        log.info('live browser closed', { user: this.user.name, reason, minutes: Math.round((Date.now() - this.startedAt) / 60000) });
        require('../services/events').record('live_browser_closed', { userId: this.user.id, detail: `${reason} after ${Math.max(1, Math.round((Date.now() - this.startedAt) / 60000))} min` });
    }

    closed(reason) {
        if (!this.closing) this.close(reason);
    }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const mods = (m) => (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);

/** http(s) addresses only (no file:, chrome:, javascript: ...). */
function normalize(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    if (/^about:blank$/i.test(s)) return 'about:blank';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try {
        const u = new URL(s);
        if (!/^https?:$/.test(u.protocol)) return null;
        return u.href;
    } catch (_) {
        return null;
    }
}

function friendlyNavError(e) {
    const m = String(e && e.message);
    if (/ERR_NAME_NOT_RESOLVED/.test(m)) return 'That site could not be found.';
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|403/.test(m)) return 'That address is not allowed.';
    if (/Timeout/i.test(m)) return 'The site took too long to answer.';
    if (/interrupted by another navigation|ERR_ABORTED/.test(m)) return null;
    return 'The page could not be opened.';
}

async function browserFor(user) {
    let b = browsers.get(user.id);
    if (b) {
        await b.ready;
        return b;
    }
    if (browsers.size >= MAX_BROWSERS) {
        // make room: the browser nobody has looked at for the longest time
        const idle = [...browsers.values()].filter((x) => !x.viewers.size).sort((a, c) => a.lastSeen - c.lastSeen)[0];
        if (!idle) throw Object.assign(new Error(`All ${MAX_BROWSERS} live browsers are in use. Try again in a few minutes.`), { code: 'busy' });
        await idle.close('made room for another user');
    }
    b = new UserBrowser(user);
    browsers.set(user.id, b);
    b.ready = b.start().catch((e) => {
        browsers.delete(user.id);
        throw e;
    });
    await b.ready;
    return b;
}

// Idle browsers are closed (their profile - logins - stays on disk).
setInterval(() => {
    const now = Date.now();
    for (const b of browsers.values()) if (!b.viewers.size && now - b.lastSeen > IDLE_MS) b.close('idle');
}, 30000).unref();

// ------------------------------------------------------------- server ----
function start() {
    system.setProcessName('live');
    require('../services/events').setSource('live');
    const server = http.createServer((req, res) => {
        if (req.url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, browsers: browsers.size, max: MAX_BROWSERS, viewers: [...browsers.values()].reduce((n, b) => n + b.viewers.size, 0), display }));
        }
        res.writeHead(404);
        res.end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    server.on('upgrade', (req, socket, head) => {
        const u = new URL(req.url, 'http://x');
        // ticket from portal-web (/api/portal/live/ticket): signed, 60 s, one user
        const t = verify(u.searchParams.get('t'), config.appSecret, TICKET_PURPOSE);
        if (u.pathname !== '/live/ws' || !t || !t.uid) {
            log.warn('live WebSocket refused: missing, invalid or expired ticket');
            socket.end('HTTP/1.1 403 Invalid Ticket\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            // connection test (portal-cli test-live): answer and close, no browser
            if (t.probe) {
                ws.send(JSON.stringify({ t: 'status', state: 'probe-ok', browsers: browsers.size, max: MAX_BROWSERS }));
                return ws.close(1000, 'probe');
            }
            connection(ws, { id: t.uid, name: t.un || t.uid }, u.searchParams);
        });
    });
    server.listen(PORT, '127.0.0.1', () => {
        log.info(`live browser service on 127.0.0.1:${PORT} (max ${MAX_BROWSERS} browsers, idle close ${IDLE_MS / 60000} min)`);
        if (process.send) process.send('ready');
    });
    const stop = async () => {
        server.close();
        await stopAll();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return server;
}

async function connection(ws, user, params) {
    let b;
    const queue = [];
    ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
            msg = JSON.parse(data.toString('utf8'));
        } catch (_) {
            return;
        }
        if (!msg || typeof msg.t !== 'string') return;
        if (msg.t === 'ack') return b && b.ack(ws); // frame drawn: not queued behind input
        if (!b) queue.push(msg);
        else run(msg);
    });
    // input is applied in order, one at a time (a click is down + up)
    let chain = Promise.resolve();
    const run = (msg) => {
        chain = chain.then(() => b.input(msg)).catch((e) => log.warn('live input failed', { type: msg.t, error: e.message }));
    };
    ws.on('close', () => b && b.detach(ws));
    ws.send(JSON.stringify({ t: 'status', state: 'starting' }));
    try {
        b = await browserFor(user);
    } catch (e) {
        ws.send(JSON.stringify({ t: 'error', message: e.code === 'busy' ? e.message : 'The live browser could not start on the server.', detail: e.message.split('\n')[0].slice(0, 200) }));
        log.error('live browser failed to start', { error: e.message });
        return ws.close(4001, 'start failed');
    }
    if (ws.readyState !== 1) return;
    b.attach(ws);
    ws.send(JSON.stringify({ t: 'status', state: 'ready' }));
    for (const m of queue.splice(0)) run(m);
    // open the requested page (start page search / address / site tile)
    const open = params.get('open');
    if (open) run({ t: open === 'newtab' ? 'newTab' : 'nav', url: params.get('url') });
}

if (require.main === module) {
    config.validate();
    require('../db').open();
    start();
}

/** Closes every browser and the egress guard (tests, shutdown). */
async function stopAll() {
    await Promise.all([...browsers.values()].map((b) => b.close('server stopping')));
    if (egressPromise) (await egressPromise).close();
    egressPromise = null;
}

module.exports = { start, stopAll, normalize, browsers, TICKET_PURPOSE, PORT };
