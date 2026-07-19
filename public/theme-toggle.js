// Static-site light/dark toggle (landing + guide pages). Progressive enhancement: the header
// button reserves its box from first paint but ships `visibility: hidden`; this script reveals it
// (adds `is-ready` → visibility: visible) and wires it, so the header geometry is final before the
// script runs and nothing shifts when it lands. Our strict CSP (script-src 'self') blocks inline
// scripts, so this is an EXTERNAL same-origin script.
//
// It stays in lock-step with public/theme-init.js and MantineProvider (src/App.tsx):
//   key       = 'mantine-color-scheme-value'
//   attribute = 'data-mantine-color-scheme' on <html>, computed to 'light' | 'dark'
// theme-init.js has already set the attribute to 'light' or 'dark' before first paint, so the
// toggle reads the live attribute, writes the opposite as an EXPLICIT 'light'/'dark' (same as the
// app's ThemeToggle), and the shared storage key keeps the landing, guides, and /app in sync.
(function () {
  var KEY = 'mantine-color-scheme-value';
  var root = document.documentElement;

  function current() {
    return root.getAttribute('data-mantine-color-scheme') === 'dark' ? 'dark' : 'light';
  }

  function relabel(btn) {
    var next = current() === 'dark' ? 'light' : 'dark';
    var text = 'Switch to ' + next + ' theme';
    btn.setAttribute('aria-label', text);
    btn.setAttribute('title', text);
  }

  var buttons = document.querySelectorAll('.byo-theme-toggle');
  for (var i = 0; i < buttons.length; i += 1) {
    (function (btn) {
      btn.classList.add('is-ready');
      relabel(btn);
      btn.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-mantine-color-scheme', next);
        try {
          window.localStorage.setItem(KEY, next);
        } catch (e) {
          /* storage blocked (privacy mode) — the in-page toggle still works for this view */
        }
        relabel(btn);
      });
    })(buttons[i]);
  }

  // Cross-tab / cross-page sync: when the workbench (/app) or another tab changes the scheme,
  // reflect it here live (matches Mantine's own storage-driven sync) so the whole site stays
  // consistent without a reload.
  window.addEventListener('storage', function (event) {
    if (event.key !== KEY) return;
    var value = event.newValue;
    var dark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    var scheme = value === 'light' || value === 'dark' ? value : dark ? 'dark' : 'light';
    root.setAttribute('data-mantine-color-scheme', scheme);
    for (var j = 0; j < buttons.length; j += 1) relabel(buttons[j]);
  });
})();
