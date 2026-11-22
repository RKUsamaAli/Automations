// Example injected script: form helper.
// Marks required fields that are still empty when the user submits a form,
// and scrolls to the first one (handy on small iPhone screens).

document.addEventListener(
    'submit',
    function (event) {
        var form = event.target;
        if (!form || !form.querySelectorAll) return;
        var missing = Array.prototype.filter.call(form.querySelectorAll('[required]'), function (el) {
            return !String(el.value || '').trim();
        });
        missing.forEach(function (el) {
            el.style.outline = '2px solid #e5484d';
            el.addEventListener('input', function () {
                el.style.outline = '';
            }, { once: true });
        });
        if (missing.length) missing[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    true
);
