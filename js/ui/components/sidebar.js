/* js/ui/components/sidebar.js - Collapsible Navigation Sidebar */
import { ProxyStore } from '../../storage/proxyStore.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

export class Sidebar {
  static async render(container, activeView, onNavigate) {
    const defaultProxy = await ProxyStore.getDefault();
    const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';

    if (isCollapsed) {
      container.classList.add('collapsed');
    } else {
      container.classList.remove('collapsed');
    }

    container.innerHTML = `
      <div class="sidebar-header">
        <div class="brand-wrapper">
          <img src="src/icon.png" class="pixel-art" style="width:36px; height:36px; flex-shrink:0;" alt="NnzRP Icon">
          <div class="brand-text">
            <div style="font-weight:800; font-size:1.1rem; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">NnzRP</div>
          </div>
        </div>
        <button class="sidebar-toggle-btn" id="btn-collapse-sidebar" title="${isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="${isCollapsed ? 'M13 5l7 7-7 7M5 5l7 7-7 7' : 'M11 19l-7-7 7-7M19 19l-7-7 7-7'}"></path>
          </svg>
        </button>
      </div>

      <nav class="sidebar-nav">
        <div class="nav-item ${activeView === 'chat' ? 'active' : ''}" data-view="chat" data-tooltip="Roleplay Chat">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
          <span class="nav-label">Roleplay Chat</span>
        </div>

        <div class="nav-item ${activeView === 'characters' ? 'active' : ''}" data-view="characters" data-tooltip="AI Characters">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
          <span class="nav-label">AI Characters</span>
        </div>

        <div class="nav-item ${activeView === 'personas' ? 'active' : ''}" data-view="personas" data-tooltip="User Personas">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
          <span class="nav-label">User Personas</span>
        </div>

        <div class="nav-item ${activeView === 'proxies' ? 'active' : ''}" data-view="proxies" data-tooltip="Multi-Proxy Config">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
          <span class="nav-label">Multi-Proxy Config</span>
        </div>

        <div class="nav-item ${activeView === 'settings' ? 'active' : ''}" data-view="settings" data-tooltip="Global Settings">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path></svg>
          <span class="nav-label">Global Settings</span>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div class="proxy-status-card" title="${defaultProxy ? escapeAttr(defaultProxy.name + ' - ' + (defaultProxy.selectedModel || defaultProxy.provider)) : 'No Active Proxy'}">
          <div style="display:flex; align-items:center; gap:0.5rem; overflow:hidden;">
            <div class="status-dot" title="Active Engine" style="flex-shrink:0;"></div>
            <div class="proxy-info-text" style="font-weight:600; font-size:0.78rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1;">${defaultProxy ? escapeHtml(defaultProxy.name) : 'No Proxy'}</div>
          </div>
          <div class="proxy-info-text" style="font-size:0.7rem; color:var(--text-dim); margin-top:0.25rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(defaultProxy?.selectedModel || defaultProxy?.provider) || 'None'}
          </div>
        </div>
      </div>
    `;

    // Toggle Collapse Handler
    const collapseBtn = container.querySelector('#btn-collapse-sidebar');
    collapseBtn.onclick = () => {
      const currentlyCollapsed = container.classList.contains('collapsed');
      const newState = !currentlyCollapsed;
      localStorage.setItem('sidebar_collapsed', newState);
      this.render(container, activeView, onNavigate);
    };

    container.querySelectorAll('.nav-item').forEach(item => {
      item.onclick = () => {
        const view = item.dataset.view;
        onNavigate(view);
        document.querySelector('.app-sidebar')?.classList.remove('open');
      };
    });
  }
}
