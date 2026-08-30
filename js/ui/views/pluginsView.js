/* js/ui/views/pluginsView.js - Plugins: management + per-plugin settings subtabs
   ============================================================================
   Top-level view at `#plugins` (Electron-only sidebar item, added by
   sidebar.js). A subtab bar:
     - "Installed"  - install-from-.zip / enable-disable / uninstall / errors
     - one subtab per plugin settings surface (pluginManager.getSettingsForms()):
         kind:'schema' -> rendered declaratively by js/plugins/settingsForm.js
         kind:'custom' -> the plugin's own render(container) (registerSettingsTab)

   NOTHING is injected into the app Settings page any more.

   Off Electron (`pluginManager.isSupported()` false) the sidebar never shows
   the item; a manual `#plugins` hash lands here and gets a short notice.
   ============================================================================ */
import { pluginManager } from '../../plugins/pluginManager.js';
import { renderPluginSettingsForm } from '../../plugins/settingsForm.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { toggleSwitchHTML } from '../components/toggle.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

const SUB_INSTALLED = 'installed';

/** Card markup for one installed plugin. Every manifest-derived string is
 *  untrusted and escaped. `hasSettings` gets a hint pointing at its subtab. */
function pluginCardHTML(p, hasSettings) {
  return `
    <div class="card plugin-card">
      <div class="plugin-card-head">
        <div class="plugin-card-title">
          <span class="plugin-card-name">${escapeHtml(p.name || p.id)}</span>
          <span class="plugin-card-version">v${escapeHtml(p.version || '0.0.0')}</span>
          ${p.hasError ? '<span class="badge-rose">Error</span>' : ''}
        </div>
        ${toggleSwitchHTML({
          inputClass: 'plugin-enable-toggle',
          checked: !!p.enabled,
          ariaLabel: `Enable plugin ${p.name || p.id}`,
          data: { 'plugin-toggle': p.id }
        })}
      </div>
      ${p.author ? `<div class="plugin-card-author">by ${escapeHtml(p.author)}</div>` : ''}
      ${p.description ? `<p class="plugin-card-desc">${escapeHtml(p.description)}</p>` : ''}
      ${p.hasError && p.error ? `<div class="plugin-error">${escapeHtml(p.error)}</div>` : ''}
      ${p.enabled && hasSettings
        ? '<div class="plugin-card-note">Has its own settings subtab above.</div>'
        : ''}
      <div class="plugin-card-actions">
        <button type="button" class="btn btn-danger btn-sm" data-plugin-remove="${escapeAttr(p.id)}" data-plugin-name="${escapeAttr(p.name || p.id)}">Remove</button>
      </div>
    </div>
  `;
}

export class PluginsView {
  /**
   * @param {Element} container  the #view-container element
   * @param {{sub?: string}} [options]  which subtab to open first
   */
  static render(container, options = {}) {
    if (!pluginManager.isSupported()) {
      container.innerHTML = `
        <div class="view-header-row">
          <div>
            <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">Plugins</h2>
            <p style="color:var(--text-muted); font-size:0.88rem;">Plugins are only available in the Desktop app (Electron).</p>
          </div>
        </div>`;
      return;
    }

    const forms = pluginManager.getSettingsForms();
    const subtabs = [
      { id: SUB_INSTALLED, label: 'Installed' },
      ...forms.map((f, i) => ({
        id: `f${i}-${String(f.pluginId).replace(/[^a-zA-Z0-9_-]/g, '-')}`,
        label: f.label,
        form: f
      }))
    ];

    let activeSub = subtabs.some(t => t.id === options.sub) ? options.sub : SUB_INSTALLED;

    container.innerHTML = `
      <div class="view-header-row">
        <div>
          <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">Plugins</h2>
          <p style="color:var(--text-muted); font-size:0.88rem;">Plugins add tabs, buttons and fields without changing the app's core code. Only enable plugins from sources you trust - an enabled plugin runs code inside the app.</p>
        </div>
      </div>

      <div class="plugins-subtabbar" role="tablist">
        ${subtabs.map(t => `
          <button type="button" class="plugins-subtab${t.id === activeSub ? ' active' : ''}" role="tab" data-sub="${escapeAttr(t.id)}">${escapeHtml(t.label)}</button>
        `).join('')}
      </div>

      <div id="plugins-sub-body"></div>
    `;

    const bodyEl = container.querySelector('#plugins-sub-body');
    const reRender = () => PluginsView.render(container, { sub: activeSub });

    const renderInstalled = () => {
      const plugins = pluginManager.list();
      const withSettings = new Set(forms.map(f => f.pluginId));
      bodyEl.innerHTML = `
        <div class="card" style="margin-bottom:1rem;">
          <div style="display:flex; gap:0.75rem; flex-wrap:wrap; align-items:center;">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-install-plugin">
              <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
              Install from .zip file
            </button>
          </div>
        </div>
        <div class="plugins-panel" id="plugins-list">
          ${plugins.length
            ? plugins.map(p => pluginCardHTML(p, withSettings.has(p.id))).join('')
            : '<div class="card card-muted"><p style="margin:0; color:var(--text-dim); font-size:0.85rem;">No plugins installed yet.</p></div>'}
        </div>
      `;

      const installBtn = bodyEl.querySelector('#btn-install-plugin');
      if (installBtn) {
        installBtn.onclick = async () => {
          try {
            const manifest = await pluginManager.installFromDialog();
            if (manifest) {
              Toast.success(`Plugin "${manifest.name || manifest.id || 'new'}" installed.`);
              reRender();
            }
          } catch (err) {
            Toast.error('Failed to install plugin: ' + err.message);
          }
        };
      }

      bodyEl.querySelectorAll('.plugin-enable-toggle[data-plugin-toggle]').forEach(cb => {
        cb.onchange = async () => {
          const id = cb.dataset.pluginToggle;
          try {
            if (cb.checked) await pluginManager.enable(id);
            else await pluginManager.disable(id);
          } catch (err) {
            Toast.error('Failed to change plugin status: ' + err.message);
          }
          reRender();
        };
      });

      bodyEl.querySelectorAll('[data-plugin-remove]').forEach(btn => {
        btn.onclick = () => {
          const id = btn.dataset.pluginRemove;
          const name = btn.dataset.pluginName || id;
          Modal.open({
            title: 'Remove Plugin',
            contentHTML: `<p style="margin:0;">Remove plugin "${escapeHtml(name)}"? Its files are deleted from disk and everything it contributes (tabs, buttons, fields) goes away.</p>`,
            buttons: [
              { label: 'Cancel', className: 'btn-secondary', onClick: () => Modal.close() },
              {
                label: 'Remove',
                className: 'btn-danger',
                onClick: async () => {
                  try {
                    await pluginManager.uninstall(id);
                    Toast.success('Plugin removed.');
                  } catch (err) {
                    Toast.error('Failed to remove plugin: ' + err.message);
                  }
                  Modal.close();
                  activeSub = SUB_INSTALLED;
                  reRender();
                }
              }
            ]
          });
        };
      });
    };

    const renderFormSub = (form) => {
      bodyEl.innerHTML = '';
      if (form.kind === 'schema') {
        const host = pluginManager.getActiveHost(form.pluginId);
        if (!host) { bodyEl.textContent = 'Plugin is not active.'; return; }
        renderPluginSettingsForm(bodyEl, form.schema, host).catch(err => {
          console.error('[PluginsView] settings form render failed', err);
          bodyEl.textContent = 'Plugin settings panel failed to load.';
        });
      } else {
        // Escape-hatch: the plugin's own registerSettingsTab({ render }).
        try {
          form.render(bodyEl);
        } catch (err) {
          console.error('[PluginsView] plugin settings tab render failed', err);
          bodyEl.textContent = 'Plugin settings panel failed to load.';
        }
      }
    };

    const showSub = (id) => {
      const tab = subtabs.find(t => t.id === id) || subtabs[0];
      activeSub = tab.id;
      container.querySelectorAll('.plugins-subtab').forEach(b => {
        b.classList.toggle('active', b.dataset.sub === activeSub);
      });
      if (activeSub === SUB_INSTALLED) renderInstalled();
      else renderFormSub(tab.form);
    };

    container.querySelectorAll('.plugins-subtab').forEach(b => {
      b.onclick = () => showSub(b.dataset.sub);
    });

    showSub(activeSub);
  }
}
