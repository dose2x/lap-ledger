// Sets light or dark before the page paints. A separate file so the Content-Security-Policy can forbid inline scripts.
(function () {
  try {
    var t = localStorage.getItem('ledger.theme');
    if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
  } catch (e) { document.documentElement.dataset.theme = 'light'; }
})();
