(() => {
  const root = document.documentElement;
  let theme = 'light';
  try {
    if (localStorage.getItem('chorequest_theme') === 'dark') theme = 'dark';
  } catch (_) { /* Storage may be unavailable; toggling still works. */ }
  // Runs before the stylesheet to avoid a light flash on subsequent page loads.
  root.dataset.theme = theme;

  function syncButtons() {
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      const label = theme === 'dark' ? button.dataset.lightLabel : button.dataset.darkLabel;
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    syncButtons();
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      button.addEventListener('click', () => {
        theme = theme === 'light' ? 'dark' : 'light';
        root.dataset.theme = theme;
        try { localStorage.setItem('chorequest_theme', theme); } catch (_) {}
        syncButtons();
      });
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== 'chorequest_theme' && event.key !== null) return;
    theme = event.newValue === 'dark' ? 'dark' : 'light';
    root.dataset.theme = theme;
    syncButtons();
  });
})();
