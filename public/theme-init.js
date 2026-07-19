// Pre-paint color-scheme bootstrap. Our strict CSP (script-src 'self', no
// 'unsafe-inline', no per-request nonce on a static host) blocks Mantine's inline
// <ColorSchemeScript>, so this EXTERNAL same-origin script does the same job before
// first paint: read Mantine's localStorage key and set data-mantine-color-scheme on
// <html>. Same-origin, so it adds zero egress.
//
// It MUST stay in lock-step with MantineProvider (src/App.tsx) — same key, same
// default, same attribute — or the provider's mount effect would rewrite the attr and
// flash. Verified against @mantine/core 9.4.1:
//   key       = 'mantine-color-scheme-value'  (localStorageColorSchemeManager default)
//   default   = 'auto'                          (MantineProvider defaultColorScheme)
//   attribute = 'data-mantine-color-scheme' on <html>, computed to 'light' | 'dark'
//   stored value is a raw string: 'light' | 'dark' | 'auto'
(function () {
  // Read storage in its OWN try: if it throws (privacy mode), fall back to 'auto' but
  // STILL honor the OS via matchMedia below — don't let a storage error skip the
  // attribute write and flash light on a dark OS.
  var stored;
  try {
    stored = window.localStorage.getItem('mantine-color-scheme-value');
  } catch (e) {
    /* storage blocked — treat as unset ('auto') */
  }
  var scheme = stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
  var dark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute(
    'data-mantine-color-scheme',
    scheme !== 'auto' ? scheme : dark ? 'dark' : 'light'
  );
})();
