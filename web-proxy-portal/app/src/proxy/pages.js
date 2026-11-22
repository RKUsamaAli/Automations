'use strict';
/**
 * Small self-contained HTML pages the proxy engine shows (errors, expired
 * sessions, blocked sites). Inline CSS only - nothing is loaded from the portal.
 */
const escape = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderMessage({ title, message, linkText = null, linkHref = null }) {
    const link = linkText && linkHref ? `<p><a href="${escape(linkHref)}">${escape(linkText)}</a></p>` : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 -apple-system, system-ui, sans-serif; background: #f5f6f8; color: #1d2433; }
  main { max-width: 420px; margin: 16px; padding: 28px; background: #fff; border-radius: 14px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 8px; }
  a { color: #2457d6; font-weight: 600; }
  @media (prefers-color-scheme: dark) { body { background: #12151c; color: #e6e9ef; } main { background: #1c2130; } a { color: #8fb0ff; } }
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>${link}</main></body></html>`;
}

module.exports = { renderMessage, escape };
