/* js/app.js - Main Application Core & Router */
import { initDatabase } from './storage/db.js';
import { Navbar } from './ui/components/navbar.js';
import { Sidebar } from './ui/components/sidebar.js';
import { CharactersView } from './ui/views/charactersView.js';
import { ChatView } from './ui/views/chatView.js';
import { PersonasView } from './ui/views/personasView.js';
import { ProxiesView } from './ui/views/proxiesView.js';
import { SettingsView } from './ui/views/settingsView.js';

class App {
  constructor() {
    this.currentView = 'characters';
    this.activeCharacterId = null;
    this._suppressHashChange = false;
  }

  async init() {
    console.log('Initializing Aetheria RP Studio...');

    // Initialize Database & Sample Seeds
    await initDatabase();

    // Render Shell Layout
    this.renderShell();

    // Restore view from the URL hash (if any) so a page reload stays where
    // the user was instead of always bouncing back to the character list.
    const { view, params } = this.parseHash();
    await this.navigate(view, params);

    window.addEventListener('hashchange', () => {
      if (this._suppressHashChange) {
        this._suppressHashChange = false;
        return;
      }
      const { view, params } = this.parseHash();
      this.navigate(view, params);
    });
  }

  /** Reads window.location.hash into a { view, params } route descriptor. */
  parseHash() {
    const raw = window.location.hash.replace(/^#\/?/, '');
    if (!raw) return { view: 'characters', params: {} };
    const [view, ...rest] = raw.split('/');
    if (view === 'chat' && rest[0]) {
      return { view: 'chat', params: { characterId: decodeURIComponent(rest[0]) } };
    }
    return { view: view || 'characters', params: {} };
  }

  /** Reflects the current view into window.location.hash for reload/back-forward support. */
  updateHash(viewName, params) {
    const target = viewName === 'chat' && params.characterId
      ? `#chat/${encodeURIComponent(params.characterId)}`
      : `#${viewName}`;
    if (window.location.hash !== target) {
      this._suppressHashChange = true;
      window.location.hash = target;
    }
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
    this.currentView = viewName;
    if (params.characterId) {
      this.activeCharacterId = params.characterId;
    }
    this.updateHash(viewName, params.characterId ? params : { characterId: this.activeCharacterId });

    const sidebarContainer = document.getElementById('app-sidebar');
    const headerContainer = document.getElementById('main-header');
    const viewContainer = document.getElementById('view-container');

    if (!sidebarContainer || !headerContainer || !viewContainer) return;

    // Handle dedicated Fullscreen Chat vs Main Dashboard layout
    if (this.currentView === 'chat') {
      sidebarContainer.style.display = 'none';
      headerContainer.style.display = 'none';
      viewContainer.style.padding = '0';
    } else {
      sidebarContainer.style.display = 'flex';
      headerContainer.style.display = 'flex';
      viewContainer.style.padding = '1.75rem 2rem';

      await Sidebar.render(sidebarContainer, this.currentView, (targetView) => this.navigate(targetView));
      await Navbar.render(headerContainer, this.currentView, () => {
        Sidebar.render(sidebarContainer, this.currentView, (targetView) => this.navigate(targetView));
      });
    }

    // Render Target View
    viewContainer.innerHTML = '';
    
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

      case 'proxies':
        await ProxiesView.render(viewContainer);
        break;

      case 'settings':
        await SettingsView.render(viewContainer);
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
      appEl.innerHTML = `<div style="padding:2rem; color:#e11d48; font-family:sans-serif;">
        <h2>Aetheria RP Studio Initialization Error</h2>
        <pre style="background:#f1f5f9; padding:1rem; border-radius:8px; overflow:auto;">${err.stack || err.message || err}</pre>
      </div>`;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}
