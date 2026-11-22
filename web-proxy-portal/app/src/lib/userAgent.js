'use strict';
/**
 * Small, dependency-free User-Agent parser (+ Client Hints when the browser
 * sends them). Good enough for analysis: browser, engine, OS, device type.
 *
 *   parse(ua, hints) -> { browser, browserVersion, engine, os, osVersion, deviceType, deviceModel }
 */
function first(re, s) {
    const m = re.exec(s);
    return m ? m[1] : null;
}
const major = (v) => (v ? String(v).split('.').slice(0, 2).join('.') : null);

function parse(ua = '', hints = {}) {
    ua = String(ua || '');
    const out = { browser: null, browserVersion: null, engine: null, os: null, osVersion: null, deviceType: 'desktop', deviceModel: null };

    // --- bots
    if (/bot|crawler|spider|crawling|headlesschrome|lighthouse|curl\/|wget\/|python-requests|node-fetch|axios\//i.test(ua)) out.deviceType = 'bot';

    // --- OS
    let v;
    if ((v = first(/(?:iPhone|iPad|iPod).*?OS (\d+[_\d]*)/, ua))) {
        out.os = 'iOS';
        out.osVersion = v.replace(/_/g, '.');
        out.deviceModel = first(/(iPhone|iPad|iPod)/, ua);
        out.deviceType = out.deviceModel === 'iPad' ? 'tablet' : 'mobile';
    } else if (/Macintosh/.test(ua) && /Mobile\//.test(ua)) {
        out.os = 'iPadOS';
        out.deviceType = 'tablet';
        out.deviceModel = 'iPad';
    } else if ((v = first(/Android (\d+(?:\.\d+)*)/, ua)) || /Android/.test(ua)) {
        out.os = 'Android';
        out.osVersion = v;
        out.deviceModel = first(/Android [^;)]*; (?:[a-z]{2}[-_][a-z]{2}; )?([^;)]+?)(?: Build|\))/i, ua);
        out.deviceType = /Mobile/.test(ua) ? 'mobile' : 'tablet';
    } else if ((v = first(/Windows NT (\d+\.\d+)/, ua))) {
        out.os = 'Windows';
        out.osVersion = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' }[v] || v;
    } else if ((v = first(/Mac OS X (\d+[_.\d]*)/, ua))) {
        out.os = 'macOS';
        out.osVersion = v.replace(/_/g, '.');
    } else if (/CrOS/.test(ua)) out.os = 'ChromeOS';
    else if (/Linux/.test(ua)) out.os = 'Linux';

    // --- browser (order matters: many UAs contain "Chrome" and "Safari")
    const rules = [
        ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
        ['Opera', /(?:OPR|OPiOS)\/([\d.]+)/],
        ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
        ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
        ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
        ['Safari', /Version\/([\d.]+).*Safari/]
    ];
    for (const [name, re] of rules) {
        const ver = first(re, ua);
        if (ver) {
            out.browser = name;
            out.browserVersion = major(ver);
            break;
        }
    }
    if (!out.browser && /Safari/.test(ua) && /AppleWebKit/.test(ua)) out.browser = 'Safari';

    // --- engine (on iOS every browser is WebKit)
    if (out.os === 'iOS' || out.os === 'iPadOS') out.engine = 'WebKit';
    else if (/Gecko\/\d/.test(ua) && /Firefox/.test(ua)) out.engine = 'Gecko';
    else if (/Chrome|Chromium|Edg|OPR/.test(ua)) out.engine = 'Blink';
    else if (/AppleWebKit/.test(ua)) out.engine = 'WebKit';

    // --- Client Hints are more precise when present (Chromium browsers)
    if (hints.platform) out.os = hints.platform.replace(/"/g, '') || out.os;
    if (hints.platformVersion) out.osVersion = hints.platformVersion.replace(/"/g, '') || out.osVersion;
    if (hints.model && hints.model.replace(/"/g, '')) out.deviceModel = hints.model.replace(/"/g, '');
    if (hints.mobile === '?1' && out.deviceType === 'desktop') out.deviceType = 'mobile';
    return out;
}

module.exports = { parse };
