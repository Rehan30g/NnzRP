/* js/ui/components/navbar.js - Header Nav & Active Proxy Selector */
import { ProxyStore } from '../../storage/proxyStore.js';
import { escapeHtml } from '../../utils/sanitize.js';

export class Navbar {
  static async render(container, activeViewName, onProxyChange) {
    const proxies = await ProxyStore.getAll();
    const defaultProxy = await ProxyStore.getDefault();

    container.innerHTML = `
      <div class="navbar-title-wrapper" style="display:flex; align-items:center; gap:0.75rem;">
        <button class="btn-icon mobile-toggle" id="toggle-sidebar">
          <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>
        </button>
        <h2 style="font-size:1.1rem; text-transform:capitalize; margin:0;">${activeViewName}</h2>
      </div>

      <div class="navbar-proxy-wrapper" style="display:flex; align-items:center; gap:1rem;">
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <span style="font-size:0.8rem; color:var(--text-muted); white-space:nowrap;">Active Proxy:</span>
          <select class="select" id="header-proxy-select" style="padding:0.35rem 0.75rem; font-size:0.85rem; max-width:320px; text-overflow:ellipsis; overflow:hidden;" title="Active AI Proxy Engine">
            ${proxies.map(p => `
              <option value="${p.id}" ${defaultProxy && defaultProxy.id === p.id ? 'selected' : ''}>
                ${escapeHtml(p.name)} (${escapeHtml(p.selectedModel || p.provider)})
              </option>
            `).join('')}
          </select>
        </div>
      </div>
    `;

    const selectEl = container.querySelector('#header-proxy-select');
    selectEl.onchange = async (e) => {
      const selectedId = e.target.value;
      const proxy = await ProxyStore.getById(selectedId);
      if (proxy) {
        proxy.isDefault = true;
        await ProxyStore.save(proxy);
        if (onProxyChange) onProxyChange(proxy);
      }
    };

    const toggleBtn = container.querySelector('#toggle-sidebar');
    toggleBtn.onclick = () => {
      document.querySelector('.app-sidebar')?.classList.toggle('open');
    };
  }
}
