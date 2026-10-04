// Choix du thème : automatique (suit le système), clair, sombre ou Cnam. Mémorisé dans ce navigateur.

const KEY = 'planificateur-cnam:theme';
const LABELS = { auto: 'Automatique', light: 'Clair', dark: 'Sombre', cnam: 'Cnam' };
const BAR = { light: '#f2f4f1', dark: '#0e1626', cnam: '#c1002a' };

const menu = document.getElementById('theme-menu');
const label = document.getElementById('theme-label');
const meta = document.querySelector('meta[name="theme-color"]');
const systemDark = matchMedia('(prefers-color-scheme: dark)');

function current() {
  try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; }
}

function apply(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  label.textContent = LABELS[theme];
  meta.content = BAR[theme === 'auto' ? (systemDark.matches ? 'dark' : 'light') : theme];
  for (const input of menu.querySelectorAll('input[name="theme"]')) input.checked = input.value === theme;
}

menu.addEventListener('change', (ev) => {
  const theme = ev.target.value;
  try { localStorage.setItem(KEY, theme); } catch { /* choix gardé pour cette visite seulement */ }
  apply(theme);
  menu.open = false;
  menu.querySelector('summary').focus();
});

// Fermeture au clic ailleurs ou avec Échap.
document.addEventListener('click', (ev) => { if (menu.open && !menu.contains(ev.target)) menu.open = false; });
menu.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
});
systemDark.addEventListener('change', () => apply(current()));

apply(current());
