'use strict';
/**
 * Small self-contained HTML pages the proxy engine shows (errors, expired
 * sessions, blocked sites). Inline CSS only - nothing is loaded from the portal.
 */
const escape = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderMessage({ title, message, linkText = null, linkHref = null, secondaryText = null, secondaryHref = null, reference = null }) {
    const links = [
        linkText && linkHref ? `<a class="primary" href="${escape(linkHref)}">${escape(linkText)}</a>` : '',
        secondaryText && secondaryHref ? `<a href="${escape(secondaryHref)}">${escape(secondaryText)}</a>` : ''
    ].filter(Boolean).join(' ');
    const link = links ? `<p class="links">${links}</p>` : '';
    const ref = reference ? `<p class="ref">If this keeps happening, tell your administrator this reference: <code>${escape(reference)}</code></p>` : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 -apple-system, system-ui, sans-serif; background: #f5f6f8; color: #1d2433; }
  main { max-width: 420px; margin: 16px; padding: 28px; background: #fff; border-radius: 14px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 8px; }
  a { color: #2457d6; font-weight: 600; }
  .links { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
  .links a { padding: 10px 16px; border-radius: 10px; border: 1px solid #dde2ec; text-decoration: none; }
  .links a.primary { background: #2f5fe3; border-color: #2f5fe3; color: #fff; }
  .ref { font-size: 13px; color: #5b6578; margin: 14px 0 0; }
  .ref code { font: 600 14px ui-monospace, Menlo, monospace; background: #f1f3f8; padding: 2px 6px; border-radius: 6px; }
  @media (prefers-color-scheme: dark) { body { background: #12151c; color: #e6e9ef; } main { background: #1c2130; } a { color: #8fb0ff; } .links a { border-color: #2c3344; } .links a.primary { color: #0b1020; background: #8fb0ff; } .ref code { background: #252b3a; } .ref { color: #98a2b5; } }
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>${link}${ref}</main></body></html>`;
}

module.exports = { renderMessage, escape };
