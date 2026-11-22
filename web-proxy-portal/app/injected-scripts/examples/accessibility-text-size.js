// Example injected script: accessibility tweak.
// Adds a floating "A+" button that enlarges text by 10% per tap (max 150%).

(function () {
    if (document.getElementById('portal-a11y')) return;
    var scale = 1;
    var btn = document.createElement('button');
    btn.id = 'portal-a11y';
    btn.type = 'button';
    btn.textContent = 'A+';
    btn.setAttribute('aria-label', 'Increase text size');
    var s = btn.style;
    s.position = 'fixed';
    s.right = '12px';
    s.bottom = '56px';
    s.zIndex = '2147483646';
    s.width = '44px';
    s.height = '44px';
    s.borderRadius = '22px';
    s.border = 'none';
    s.background = '#2457d6';
    s.color = '#fff';
    s.font = '600 15px -apple-system, system-ui, sans-serif';
    btn.addEventListener('click', function () {
        scale = scale >= 1.5 ? 1 : Math.round((scale + 0.1) * 10) / 10;
        document.documentElement.style.fontSize = scale * 100 + '%';
    });
    document.body.appendChild(btn);
})();
