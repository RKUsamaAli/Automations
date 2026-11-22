// Example injected script: small dismissible banner at the top of proxied pages.
// Add it from the admin panel (Scripts -> Add) or with: sudo portal-cli seed-examples
//
// Available inside every injected script:
//   window.__portal.page.url   real URL of the page (https://www.example.com/path)
//   window.__portal.page.host  its hostname
// `location` shows the proxy URL - use the values above instead.

if (!document.getElementById('portal-banner')) {
    var bar = document.createElement('div');
    bar.id = 'portal-banner';
    bar.textContent = 'You are browsing ' + window.__portal.page.host + ' through the portal. Tap to hide.';
    bar.setAttribute('role', 'status');
    var s = bar.style;
    s.position = 'fixed';
    s.left = '8px';
    s.right = '8px';
    s.bottom = '8px';
    s.zIndex = '2147483647';
    s.padding = '8px 12px';
    s.borderRadius = '8px';
    s.font = '13px -apple-system, system-ui, sans-serif';
    s.background = 'rgba(20, 24, 33, 0.9)';
    s.color = '#fff';
    s.textAlign = 'center';
    bar.addEventListener('click', function () {
        bar.remove();
    });
    document.body.appendChild(bar);
}
