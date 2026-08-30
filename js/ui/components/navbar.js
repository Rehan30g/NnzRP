/* js/ui/components/navbar.js - Header Nav & Active Proxy Selector */
import { ProxyStore } from '../../storage/proxyStore.js';
import { dropdownHTML, wireDropdown } from './dropdown.js';

const VIEW_LABELS = {
  characters: 'AI Characters',
  personas: 'User Personas',
  settings: 'Settings',
  mcp: 'Custom MCP (Exp)',
  plugins: 'Plugins',
  chat: 'Roleplay Chat'
};

export class Navbar {
  static async render(container, activeViewName, onProxyChange) {
    const proxies = await ProxyStore.getAll();
    const defaultProxy = await ProxyStore.getDefault();

    // Two-line options: the profile name reads on top, its provider/model
    // dimmed underneath - the reason this is a custom dropdown rather than a
    // native <select>, which can only render one flat line per option.
    const proxyOptions = proxies.map(p => ({
      value: p.id,
      label: p.name,
      hint: p.selectedModel || p.provider
    }));

    container.innerHTML = `
      <div class="navbar-title-wrapper" style="display:flex; align-items:center; gap:0.75rem;">
        <button class="btn-icon mobile-toggle" id="toggle-sidebar" aria-label="Toggle navigation">
          <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>
        </button>
        <h2 style="font-size:1.15rem; margin:0;">${VIEW_LABELS[activeViewName] || 'NnzRP'}</h2>
      </div>

      <div class="navbar-proxy-wrapper" style="display:flex; align-items:center; gap:1rem;">
        <div style="display:flex; align-items:center; gap:0.6rem;">
          <span style="font-size:0.82rem; color:var(--text-muted); white-space:nowrap; font-weight:500;">Active Proxy</span>
          ${dropdownHTML({
            id: 'header-proxy-select',
            options: proxyOptions,
            value: defaultProxy ? defaultProxy.id : '',
            placeholder: 'No proxy configured',
            small: true,
            title: 'Active AI Proxy Engine',
            wrapperStyle: 'min-width:240px; max-width:340px;'
          })}
        </div>
      </div>
    `;

    wireDropdown(container, 'header-proxy-select', async (selectedId) => {
      const proxy = await ProxyStore.getById(selectedId);
      if (proxy) {
        proxy.isDefault = true;
        await ProxyStore.save(proxy);
        if (onProxyChange) onProxyChange(proxy);
      }
    });

    const toggleBtn = container.querySelector('#toggle-sidebar');
    toggleBtn.onclick = () => {
      document.querySelector('.app-sidebar')?.classList.toggle('open');
    };
  }
}
