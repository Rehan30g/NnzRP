/* js/ui/theme.js - Runtime theme application (mode + accent colours)
   ===================================================================
   Pure DOM side of the appearance system; persistence lives in
   js/storage/themeStore.js. See the header comment in css/variables.css for
   how `data-theme` interacts with the `prefers-color-scheme` media query.
   =================================================================== */
import { ThemeStore, DEFAULT_ACCENT } from '../storage/themeStore.js';

/**
 * Curated accent pairs offered as one-click swatches in Settings -> Appearance.
 * Users can still pick any colour via the two <input type="color"> fields.
 */
export const ACCENT_PRESETS = [
  { name: 'Indigo',  primary: '#4f46e5', secondary: '#7c3aed' },
  { name: 'Violet',  primary: '#7c3aed', secondary: '#c026d3' },
  { name: 'Cyan',    primary: '#0284c7', secondary: '#0891b2' },
  { name: 'Emerald', primary: '#059669', secondary: '#0d9488' },
  { name: 'Amber',   primary: '#d97706', secondary: '#ea580c' },
  { name: 'Rose',    primary: '#e11d48', secondary: '#db2777' },
  { name: 'Slate',   primary: '#475569', secondary: '#64748b' }
];

/**
 * Stamps (or clears) `data-theme` on <html>.
 *
 * 'auto' deliberately REMOVES the attribute rather than resolving the OS
 * preference in JS - that hands the decision to the `prefers-color-scheme`
 * media query in css/variables.css, so the app follows a live OS theme switch
 * with no listener and no repaint bookkeeping on our side.
 *
 * `data-theme-mode` always carries the raw preference so UI (the Appearance
 * segmented control) can show which of the three the user actually chose.
 */
export function applyThemeMode(mode) {
  const normalized = ThemeStore.normalizeMode(mode);
  const root = document.documentElement;
  if (normalized === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', normalized);
  }
  root.setAttribute('data-theme-mode', normalized);
  return normalized;
}

/**
 * Writes the user's accent choice as inline custom properties on <html>, which
 * outrank both palettes in css/variables.css and therefore apply in light AND
 * dark mode.
 *
 * Everything except the two picked colours is DERIVED with `color-mix()` against
 * theme tokens rather than stored, so a custom accent keeps working when the
 * theme flips: the soft washes mix into whatever `--bg-surface` currently is,
 * and the hover shade mixes toward `--text-main` (darker in light mode, lighter
 * in dark mode) instead of unconditionally toward black.
 */
export function applyAccent(accent) {
  const { primary, secondary } = ThemeStore.normalizeAccent(accent);
  const root = document.documentElement;
  const isDefault = primary === DEFAULT_ACCENT.primary && secondary === DEFAULT_ACCENT.secondary;

  // Default accent => remove the overrides entirely so each theme's own tuned
  // accent tokens (indigo #4f46e5 in light, the lighter #6366f1 in dark) apply.
  const props = [
    '--accent-primary', '--accent-primary-hover', '--accent-secondary',
    '--text-accent', '--border-focus', '--gradient-primary', '--gradient-accent',
    '--accent-primary-soft', '--accent-primary-softer', '--accent-secondary-soft',
    '--accent-secondary-border', '--shadow-glow'
  ];
  if (isDefault) {
    props.forEach(p => root.style.removeProperty(p));
    return { primary, secondary };
  }

  root.style.setProperty('--accent-primary', primary);
  root.style.setProperty('--accent-primary-hover', `color-mix(in srgb, ${primary} 78%, var(--text-main))`);
  root.style.setProperty('--accent-secondary', secondary);
  // Text-on-background variant of the accent. Mixing toward `--text-main`
  // darkens it in light mode and lightens it in dark mode, which is what keeps
  // a mid-tone custom accent (e.g. emerald #059669) legible as label text on
  // the dark `--accent-primary-soft` tint used by .btn-primary.
  root.style.setProperty('--text-accent', `color-mix(in srgb, ${primary} 72%, var(--text-main))`);
  root.style.setProperty('--border-focus', primary);
  root.style.setProperty('--gradient-primary', primary);
  root.style.setProperty('--gradient-accent', secondary);
  root.style.setProperty('--accent-primary-soft', `color-mix(in srgb, ${primary} 18%, var(--bg-surface))`);
  root.style.setProperty('--accent-primary-softer', `color-mix(in srgb, ${primary} 10%, var(--bg-surface))`);
  root.style.setProperty('--accent-secondary-soft', `color-mix(in srgb, ${secondary} 12%, var(--bg-surface))`);
  root.style.setProperty('--accent-secondary-border', `color-mix(in srgb, ${secondary} 40%, var(--bg-surface))`);
  root.style.setProperty('--shadow-glow', `0 0 0 2px color-mix(in srgb, ${primary} 30%, transparent)`);

  return { primary, secondary };
}

/**
 * Boot-time application. `index.html`'s inline script has already applied the
 * localStorage mirror before first paint; this re-applies from the IndexedDB
 * source of truth (and refreshes the mirror) in case they ever diverge - e.g.
 * after a backup restore, or if localStorage was cleared.
 */
export async function initTheme() {
  const [mode, accent] = await Promise.all([ThemeStore.getMode(), ThemeStore.getAccent()]);
  applyThemeMode(mode);
  applyAccent(accent);
  ThemeStore.writeCachedMode(mode);
  ThemeStore.writeCachedAccent(accent);
  return { mode, accent };
}

/** Persist + apply in one call (used by Settings -> Appearance). */
export async function setThemeMode(mode) {
  const saved = await ThemeStore.setMode(mode);
  applyThemeMode(saved);
  return saved;
}

/** Persist + apply in one call (used by Settings -> Appearance). */
export async function setAccent(accent) {
  const saved = await ThemeStore.setAccent(accent);
  applyAccent(saved);
  return saved;
}
