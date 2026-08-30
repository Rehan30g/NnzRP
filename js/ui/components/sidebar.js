/* js/ui/components/sidebar.js - Collapsible Navigation Sidebar */
import { ProxyStore } from '../../storage/proxyStore.js';
import { pluginManager } from '../../plugins/pluginManager.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

// Fallback glyph for a plugin nav item whose manifest supplies no icon.
const DEFAULT_PLUGIN_ICON_SVG = '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect></svg>';

/**
 * Markup for the plugin-contributed nav items appended after the 5 fixed ones.
 * Electron-only: `pluginManager.getNavTabs()` is `[]` when unsupported, so this
 * returns '' on every non-Electron build. `tab.label` is untrusted manifest
 * text and is escaped; `tab.icon` is an SVG string by contract (same treatment
 * as every other inline SVG here) and a missing/blank one falls back to the
 * puzzle-piece glyph above.
 */
function pluginNavItemsHTML(currentHash) {
  if (!pluginManager.isSupported()) return '';
  return pluginManager.getNavTabs().map(tab => {
    const route = `plugin:${tab.pluginId}:${tab.id}`;
    const isActive = currentHash === `#${route}`;
    const icon = (typeof tab.icon === 'string' && tab.icon.trim().startsWith('<svg'))
      ? tab.icon
      : DEFAULT_PLUGIN_ICON_SVG;
    return `
        <div class="nav-item nav-item-plugin ${isActive ? 'active' : ''}" data-plugin-route="${escapeAttr(route)}" data-tooltip="${escapeAttr(tab.label)}">
          ${icon}
          <span class="nav-label">${escapeHtml(tab.label)}</span>
        </div>`;
  }).join('');
}

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
            <div style="font-weight:800; font-size:1.1rem; background: linear-gradient(135deg, var(--brand-gradient-from) 0%, var(--brand-gradient-to) 100%); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">NnzRP</div>
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

        <!-- Same short-visible-label/full-tooltip split as the MCP item below:
             "AI Characters"/"User Personas" as a nav-label was long enough to
             wrap/crowd the 4-tab mobile bottom bar (same nav-label markup
             renders both the desktop sidebar and the mobile bar - no separate
             mobile text). The fuller name lives on the desktop-only tooltip. -->
        <div class="nav-item ${activeView === 'characters' ? 'active' : ''}" data-view="characters" data-tooltip="AI Characters">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
          <span class="nav-label">Characters</span>
        </div>

        <div class="nav-item ${activeView === 'personas' ? 'active' : ''}" data-view="personas" data-tooltip="User Personas">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
          <span class="nav-label">Personas</span>
        </div>

        <!-- The former standalone "Multi-Proxy Config" item lived here. It is now
             the "Proxies" tab inside Settings; #proxies still resolves (as a
             redirect into that tab) for old bookmarks - see App.parseHash(). -->
        <div class="nav-item ${activeView === 'settings' ? 'active' : ''}" data-view="settings" data-tooltip="Settings">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path></svg>
          <span class="nav-label">Settings</span>
        </div>

        <!-- Label is just "MCP": this same markup renders BOTH the desktop
             sidebar item and the mobile bottom-nav tab (there is no separate
             mobile label mechanism), and "Custom MCP (Exp)" wrapped/crowded
             the bottom bar. The longer descriptive name is kept on the
             desktop-only hover tooltip. -->
        <div class="nav-item ${activeView === 'mcp' ? 'active' : ''}" data-view="mcp" data-tooltip="Custom MCP (Exp)">
          <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
          <span class="nav-label">MCP</span>
        </div>

        <!-- Plugin MANAGEMENT (install / enable / uninstall) - a top-level view
             at #plugins, not a Settings tab. Electron-only: pluginManager
             .isSupported() is false on the PWA / browser / Android APK, so this
             item is absent there (and the mobile bottom bar never gains a 6th
             tab). Plugin-CONTRIBUTED settings panels still live in Settings. -->
        ${pluginManager.isSupported() ? `
        <div class="nav-item ${activeView === 'plugins' ? 'active' : ''}" data-view="plugins" data-tooltip="Plugins">
          ${DEFAULT_PLUGIN_ICON_SVG}
          <span class="nav-label">Plugins</span>
        </div>` : ''}
        ${pluginNavItemsHTML(window.location.hash)}
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
        if (item.dataset.pluginRoute) {
          // Plugin routes go through the hash (picked up by app.js's
          // hashchange listener -> parseHash -> navigate); no change to the
          // onNavigate(view) contract the 5 built-in items rely on.
          window.location.hash = `#${item.dataset.pluginRoute}`;
        } else if (item.dataset.view) {
          onNavigate(item.dataset.view);
        }
        document.querySelector('.app-sidebar')?.classList.remove('open');
      };
    });
  }
}
