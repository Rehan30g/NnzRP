/* js/storage/themeStore.js - Appearance preferences (theme mode + accent colours)
   ==============================================================================
   IndexedDB (`settings` store) is the source of truth, following the exact same
   pattern as MCPStore's `mcpGlobalEnabled`/`mcpImmersiveRoleplay` flags.

   IndexedDB is asynchronous, so it cannot be read before the browser's first
   paint - which would mean a white flash on every launch for a dark-theme user.
   Every write is therefore ALSO mirrored into localStorage (synchronous), and
   the inline bootstrap script in `index.html` reads that mirror to stamp
   `data-theme` / the accent custom properties on <html> before anything paints.
   The mirror is a cache, never the authority: `initTheme()` re-reads IndexedDB
   on boot and re-applies (plus refreshes the mirror if they ever disagree).
   ============================================================================== */
import { db } from './db.js';

export const THEME_MODES = ['auto', 'light', 'dark'];

/** Must match the light-theme accent tokens in css/variables.css. */
export const DEFAULT_ACCENT = {
  primary: '#4f46e5',
  secondary: '#7c3aed'
};

/** localStorage keys - also hardcoded in index.html's bootstrap script. */
export const LS_MODE_KEY = 'nnzrp_theme_mode';
export const LS_ACCENT_KEY = 'nnzrp_theme_accent';

const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

export class ThemeStore {
  static normalizeMode(mode) {
    return THEME_MODES.includes(mode) ? mode : 'auto';
  }

  static normalizeAccent(accent) {
    const src = (accent && typeof accent === 'object') ? accent : {};
    return {
      primary: isHexColor(src.primary) ? src.primary.toLowerCase() : DEFAULT_ACCENT.primary,
      secondary: isHexColor(src.secondary) ? src.secondary.toLowerCase() : DEFAULT_ACCENT.secondary
    };
  }

  /* ---- Theme mode (auto | light | dark) ---- */

  static async getMode() {
    try {
      const rec = await db.get('settings', 'themeMode');
      return this.normalizeMode(rec ? rec.value : undefined);
    } catch {
      return this.normalizeMode(this.readCachedMode());
    }
  }

  static async setMode(mode) {
    const normalized = this.normalizeMode(mode);
    await db.put('settings', { key: 'themeMode', value: normalized });
    this.writeCachedMode(normalized);
    return normalized;
  }

  /* ---- Accent colours ---- */

  static async getAccent() {
    try {
      const rec = await db.get('settings', 'themeAccent');
      return this.normalizeAccent(rec ? rec.value : undefined);
    } catch {
      return this.normalizeAccent(this.readCachedAccent());
    }
  }

  static async setAccent(accent) {
    const normalized = this.normalizeAccent(accent);
    await db.put('settings', { key: 'themeAccent', value: normalized });
    this.writeCachedAccent(normalized);
    return normalized;
  }

  /* ---- Synchronous localStorage mirror (pre-paint fast path) ---- */

  static readCachedMode() {
    try {
      return this.normalizeMode(localStorage.getItem(LS_MODE_KEY));
    } catch {
      return 'auto';
    }
  }

  static writeCachedMode(mode) {
    try {
      localStorage.setItem(LS_MODE_KEY, this.normalizeMode(mode));
    } catch { /* private mode / quota - the IndexedDB value still persists */ }
  }

  static readCachedAccent() {
    try {
      return this.normalizeAccent(JSON.parse(localStorage.getItem(LS_ACCENT_KEY) || '{}'));
    } catch {
      return { ...DEFAULT_ACCENT };
    }
  }

  static writeCachedAccent(accent) {
    try {
      localStorage.setItem(LS_ACCENT_KEY, JSON.stringify(this.normalizeAccent(accent)));
    } catch { /* see writeCachedMode */ }
  }
}
