/* js/app.js - Main Application Core & Router */
import { initDatabase } from './storage/db.js';
import { Navbar } from './ui/components/navbar.js';
import { Sidebar } from './ui/components/sidebar.js';
import { CharactersView } from './ui/views/charactersView.js';
import { ChatView } from './ui/views/chatView.js';
import { PersonasView } from './ui/views/personasView.js';
import { SettingsView } from './ui/views/settingsView.js';
import { MCPView } from './ui/views/mcpView.js';
import { MCPToolRegistry } from './services/mcpToolRegistry.js';
import { CharacterStore } from './storage/characterStore.js';
import { initTheme } from './ui/theme.js';
import { Toast } from './ui/components/toast.js';
import { maybeShowOnboardingWizard } from './ui/components/onboardingWizard.js';

/**
 * Window-title suffixes per route. `navigate()` composes these into
 * "NnzRP - <suffix>"; the chat route substitutes the character's own name
 * instead (see applyWindowTitle).
 */
const VIEW_TITLES = {
  characters: 'AI Characters',
  personas: 'User Personas',
  settings: 'Settings',
  mcp: 'Custom MCP',
  chat: 'Roleplay Chat'
};

class App {
  constructor() {
    this.currentView = null;
    this.activeCharacterId = null;
    this._titleRequestId = 0;
  }

  async init() {
    console.log('Initializing NnzRP...');

    // Initialize Database & Sample Seeds
    await initDatabase();

    // Re-apply the appearance preference from its IndexedDB source of truth.
    // index.html's inline bootstrap already applied the localStorage mirror
    // before first paint; this only corrects a divergence (e.g. after a backup
    // restore, or if localStorage was cleared). Never blocks on network I/O.
    await initTheme().catch(err => console.warn('Theme init failed:', err.message));

    // Warm up enabled MCP servers (populates the tool cache and, for stdio
    // servers, spawns their child process) so the first chat message doesn't
    // have to pay that cost - fire-and-forget, must never block app boot on
    // a slow/unreachable MCP server.
    MCPToolRegistry.getActiveTools().catch(err => console.warn('MCP warm-up failed:', err.message));

    // Render Shell Layout
    this.renderShell();

    // Listen to hash changes for browser back/forward and direct URL navigation
    window.addEventListener('hashchange', () => {
      const { view, params } = this.parseHash();
      this.navigate(view, params);
    });

    // Global F11 Key Toggle for Fullscreen
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F11') {
        e.preventDefault();
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      }
    });

    // Bind Custom Titlebar Window Controls (Minimize, Maximize, Close)
    const btnMinimize = document.getElementById('btn-win-minimize');
    const btnMaximize = document.getElementById('btn-win-maximize');
    const btnClose = document.getElementById('btn-win-close');

    if (window.electronAPI) {
      if (btnMinimize) btnMinimize.onclick = () => window.electronAPI.minimizeWindow();
      if (btnMaximize) btnMaximize.onclick = () => window.electronAPI.maximizeWindow();
      if (btnClose) btnClose.onclick = () => window.electronAPI.closeWindow();
    } else {
      // Hide window control buttons when running in standard browser
      if (btnMinimize) btnMinimize.style.display = 'none';
      if (btnMaximize) btnMaximize.style.display = 'none';
      if (btnClose) btnClose.style.display = 'none';
    }

    // Android hardware/gesture back button (installed APK only - the
    // @capacitor/app plugin's global is only ever present inside the native
    // WebView, so this is a no-op in Electron/plain-browser builds). Fully
    // overrides Capacitor's default goBack()-then-exit handling: from any
    // view other than the character library, back returns to the library
    // instead of exiting; from the library itself, exiting needs two presses
    // within 2s (with a hint toast on the first) rather than one, matching
    // the standard Android "press back again to exit" pattern.
    const capacitorApp = window.Capacitor?.Plugins?.App;
    if (capacitorApp) {
      let lastBackPressAt = 0;
      capacitorApp.addListener('backButton', () => {
        const { view: currentView } = this.parseHash();
        if (currentView !== 'characters') {
          this.navigate('characters');
          return;
        }
        const now = Date.now();
        if (now - lastBackPressAt < 2000) {
          capacitorApp.exitApp();
        } else {
          lastBackPressAt = now;
          Toast.info('Press back again to exit');
        }
      });
    }

    // Restore view from the URL hash (if any)
    const { view, params } = this.parseHash();
    await this.navigate(view, params);

    // First-run setup wizard - shown as an overlay on top of whatever route
    // just rendered above (normally the character library), not a route of
    // its own. No-ops instantly after the first successful run (or an
    // explicit Skip) via js/storage/onboardingStore.js's completion flag.
    await maybeShowOnboardingWizard().catch(err => console.warn('Onboarding wizard failed to show:', err.message));
  }

  /** Reads window.location.hash into a { view, params } route descriptor. */
  parseHash() {
    const raw = window.location.hash.replace(/^#\/?/, '');
    if (!raw) return { view: 'characters', params: {} };
    const [view, ...rest] = raw.split('/');
    if (view === 'chat' && rest[0]) {
      let characterId = rest[0];
      try { characterId = decodeURIComponent(rest[0]); } catch { /* malformed hash - use raw value */ }
      return { view: 'chat', params: { characterId } };
    }
    // The standalone Multi-Proxy Config page was folded into Settings as its
    // "Proxies" tab (the sidebar no longer links to it). The old #proxies route
    // is kept alive as a redirect rather than deleted, so existing bookmarks,
    // the restored-on-reload hash, and any stale link land on the right tab
    // instead of a dead route.
    if (view === 'proxies') {
      return { view: 'settings', params: { tab: 'proxies' } };
    }
    if (view === 'settings' && rest[0]) {
      return { view: 'settings', params: { tab: rest[0] } };
    }
    return { view: view || 'characters', params: {} };
  }

  /** Reflects the current view into window.location.hash for reload/back-forward support. */
  updateHash(viewName, params) {
    const target = viewName === 'chat' && params.characterId
      ? `#chat/${encodeURIComponent(params.characterId)}`
      : (viewName === 'settings' && params.tab ? `#settings/${params.tab}` : `#${viewName}`);
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
  }

  /**
   * Sets the window title to "NnzRP - <context>", where context is the open
   * view's label or, in a chat, the character being talked to.
   *
   * Both surfaces have to be updated: `document.title` (which Electron mirrors
   * into the taskbar / alt-tab entry) AND the `.titlebar-title` span, since the
   * BrowserWindow is frameless (`frame: false` in main.js) and draws its own
   * titlebar in `index.html`. `textContent` - never innerHTML - because the
   * character name is user/import-supplied.
   */
  async applyWindowTitle(viewName, params = {}) {
    let context = VIEW_TITLES[viewName] || '';
    const requestId = ++this._titleRequestId;

    if (viewName === 'chat') {
      const charId = params.characterId || this.activeCharacterId;
      try {
        const character = charId ? await CharacterStore.getById(charId) : null;
        if (character && character.name) context = `Chat with ${character.name}`;
      } catch {
        /* fall back to the generic "Roleplay Chat" label */
      }
    }

    if (requestId !== this._titleRequestId) return; // superseded by a newer navigation

    const title = context ? `NnzRP - ${context}` : 'NnzRP';
    document.title = title;
    const titlebarEl = document.getElementById('titlebar-title');
    if (titlebarEl) titlebarEl.textContent = title;
  }

  renderShell() {
    const appEl = document.getElementById('app');
    if (!appEl) return;
    appEl.innerHTML = `
      <aside class="app-sidebar" id="app-sidebar"></aside>
      <main class="app-main">
        <header class="main-header" id="main-header"></header>
        <section class="view-container" id="view-container"></section>
      </main>
    `;
  }

  async navigate(viewName, params = {}) {
    const targetCharId = params.characterId || this.activeCharacterId;
    // `params.tab` must break the "already here" short-circuit: arriving at
    // #proxies while Settings is already open has to still switch to the
    // Proxies tab rather than silently no-op.
    const sameView = this.currentView === viewName
      && (viewName !== 'chat' || this.activeCharacterId === targetCharId)
      && !params.tab;
    if (sameView) {
      return; // Already on requested view
    }

    // ChatView's generation state (in-flight fetch, an open MCP tool-permission
    // prompt, window-level keydown/message listeners) is a module-level
    // singleton that outlives this route swap unless explicitly torn down.
    // Every navigation path funnels through here - hashchange, sidebar clicks,
    // the dedicated Back button, a stray link inside a chat message - so this
    // is the one place that can reliably catch all of them. A no-op when chat
    // isn't (or wasn't) mounted. See CLAUDE.md's chatView-internals notes.
    ChatView.teardown();

    this.currentView = viewName;
    if (params.characterId) {
      this.activeCharacterId = params.characterId;
    }
    this.updateHash(viewName, params.characterId ? params : { characterId: this.activeCharacterId });

    // Window/titlebar text follows the route. Fire-and-forget: it needs an async
    // character lookup for the chat route, and nothing below depends on it.
    this.applyWindowTitle(viewName, params);

    const sidebarContainer = document.getElementById('app-sidebar');
    const headerContainer = document.getElementById('main-header');
    const viewContainer = document.getElementById('view-container');

    if (!sidebarContainer || !headerContainer || !viewContainer) return;

    // Handle dedicated Fullscreen Chat vs Main Dashboard layout
    if (this.currentView === 'chat') {
      sidebarContainer.style.display = 'none';
      headerContainer.style.display = 'none';
      viewContainer.classList.add('chat-mode');
      viewContainer.style.padding = '0';
    } else {
      sidebarContainer.style.display = 'flex';
      headerContainer.style.display = 'flex';
      viewContainer.classList.remove('chat-mode');
      viewContainer.style.padding = '1.75rem 2rem';

      await Sidebar.render(sidebarContainer, this.currentView, (targetView) => this.navigate(targetView));
      await Navbar.render(headerContainer, this.currentView, () => {
        Sidebar.render(sidebarContainer, this.currentView, (targetView) => this.navigate(targetView));
      });
    }

    // Render Target View Loading State
    viewContainer.innerHTML = `
      <div style="display:flex; justify-content:center; align-items:center; min-height:300px; color:var(--text-muted); gap:0.75rem;">
        <div class="app-loading-spinner" style="width:24px; height:24px; margin:0;"></div>
        <span>Loading View...</span>
      </div>
    `;
    
    switch (this.currentView) {
      case 'characters':
        await CharactersView.render(viewContainer, (charId) => {
          this.navigate('chat', { characterId: charId });
        });
        break;

      case 'chat':
        await ChatView.render(viewContainer, this.activeCharacterId, {
          onBack: () => this.navigate('characters'),
          onProxyChanged: () => {
            Sidebar.render(sidebarContainer, this.currentView, (targetView) => this.navigate(targetView));
          }
        });
        break;

      case 'personas':
        await PersonasView.render(viewContainer);
        break;

      case 'settings':
        await SettingsView.render(viewContainer, { tab: params.tab });
        break;

      case 'mcp':
        await MCPView.render(viewContainer);
        break;

      default:
        await CharactersView.render(viewContainer, (charId) => {
          this.navigate('chat', { characterId: charId });
        });
    }
  }
}

function bootApp() {
  window.aetheriaApp = new App();
  window.aetheriaApp.init().catch(err => {
    console.error('App initialization failed:', err);
    const appEl = document.getElementById('app');
    if (appEl) {
      // Hex fallbacks kept deliberately: this screen has to render even if the
      // failure happened before/around theme setup, so it must not depend on
      // the custom properties resolving.
      appEl.innerHTML = `<div style="padding:2rem; color:var(--accent-rose, #e11d48); font-family:sans-serif;">
        <h2>NnzRP Initialization Error</h2>
        <pre style="background:var(--bg-inset, #f1f5f9); color:var(--text-main, #0f172a); padding:1rem; border-radius:8px; overflow:auto;">${err.stack || err.message || err}</pre>
      </div>`;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}
