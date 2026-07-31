// Theme initialization - runs before React to prevent flash of wrong theme
(function () {
  var validThemes = ['light', 'dark', 'system'];
  try {
    var stored = localStorage.getItem('capybara-theme');
    var parsed = stored ? JSON.parse(stored) : null;
    var theme =
      parsed && parsed.state && validThemes.indexOf(parsed.state.theme) !== -1
        ? parsed.state.theme
        : 'system';
    var isDark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.classList.add('dark');
    }
  }
})();
