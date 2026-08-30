/* js/ui/views/pluginsView.js - Plugin management (Electron-only)
   ============================================================================
   Top-level view at `#plugins` (sidebar item added by sidebar.js, both
   Electron-only). Install-from-.zip, enable/disable, uninstall, error badge.

   Plugin-CONTRIBUTED settings panels (pluginManager.getSettingsTabs()) still
   live in the Settings page - this view only manages which plugins exist and
   whether they're enabled. A mutation here can add/remove those contributed
   tabs, so Settings re-reads getSettingsTabs() on its next render; it does not
   live-update while already open.

   Off Electron (`pluginManager.isSupported()` false) the sidebar never shows
   the item; a manual `#plugins` hash lands here and gets a short notice.
   ============================================================================ */
import { pluginManager } from '../../plugins/pluginManager.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { toggleSwitchHTML } from '../components/toggle.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

/** Card markup for one installed plugin. Every manifest-derived string
 *  (name/version/author/description/error) is untrusted and escaped. */
function pluginCardHTML(p, contributedSettingsTabs) {
  const contributes = contributedSettingsTabs.filter(t => t.pluginId === p.id);
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
          ariaLabel: `Aktifkan plugin ${p.name || p.id}`,
          data: { 'plugin-toggle': p.id }
        })}
      </div>
      ${p.author ? `<div class="plugin-card-author">oleh ${escapeHtml(p.author)}</div>` : ''}
      ${p.description ? `<p class="plugin-card-desc">${escapeHtml(p.description)}</p>` : ''}
      ${p.hasError && p.error ? `<div class="plugin-error">${escapeHtml(p.error)}</div>` : ''}
      ${p.enabled && contributes.length
        ? `<div class="plugin-card-note">Menambahkan tab pengaturan sendiri: ${contributes.map(t => escapeHtml(t.label)).join(', ')}.</div>`
        : ''}
      <div class="plugin-card-actions">
        <button type="button" class="btn btn-danger btn-sm" data-plugin-remove="${escapeAttr(p.id)}" data-plugin-name="${escapeAttr(p.name || p.id)}">Hapus</button>
      </div>
    </div>
  `;
}

export class PluginsView {
  /**
   * @param {Element} container  the #view-container element
   */
  static render(container) {
    if (!pluginManager.isSupported()) {
      container.innerHTML = `
        <div class="view-header-row">
          <div>
            <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">Plugins</h2>
            <p style="color:var(--text-muted); font-size:0.88rem;">Plugin hanya tersedia di aplikasi Desktop (Electron).</p>
          </div>
        </div>`;
      return;
    }

    const plugins = pluginManager.list();
    const contributedSettingsTabs = pluginManager.getSettingsTabs();

    container.innerHTML = `
      <div class="view-header-row">
        <div>
          <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">Plugins</h2>
          <p style="color:var(--text-muted); font-size:0.88rem;">Plugin menambah tab, tombol, dan field tanpa mengubah kode inti aplikasi. Aktifkan hanya plugin dari sumber yang kamu percaya - plugin yang aktif menjalankan kode di dalam aplikasi.</p>
        </div>
        <div style="display:flex; gap:0.75rem;">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-install-plugin">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
            Install dari file .zip
          </button>
        </div>
      </div>

      <div class="plugins-panel" id="plugins-list">
        ${plugins.length
          ? plugins.map(p => pluginCardHTML(p, contributedSettingsTabs)).join('')
          : '<div class="card card-muted"><p style="margin:0; color:var(--text-dim); font-size:0.85rem;">Belum ada plugin terpasang.</p></div>'}
      </div>
    `;

    const reRender = () => PluginsView.render(container);

    const installBtn = container.querySelector('#btn-install-plugin');
    if (installBtn) {
      installBtn.onclick = async () => {
        try {
          const manifest = await pluginManager.installFromDialog();
          if (manifest) {
            Toast.success(`Plugin "${manifest.name || manifest.id || 'baru'}" berhasil dipasang.`);
            reRender();
          }
        } catch (err) {
          Toast.error('Gagal memasang plugin: ' + err.message);
        }
      };
    }

    container.querySelectorAll('.plugin-enable-toggle[data-plugin-toggle]').forEach(cb => {
      cb.onchange = async () => {
        const id = cb.dataset.pluginToggle;
        try {
          if (cb.checked) await pluginManager.enable(id);
          else await pluginManager.disable(id);
        } catch (err) {
          Toast.error('Gagal mengubah status plugin: ' + err.message);
        }
        reRender();
      };
    });

    container.querySelectorAll('[data-plugin-remove]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.pluginRemove;
        const name = btn.dataset.pluginName || id;
        Modal.open({
          title: 'Hapus Plugin',
          contentHTML: `<p style="margin:0;">Hapus plugin "${escapeHtml(name)}"? File plugin akan dihapus dari disk dan kontribusinya (tab, tombol, field) hilang.</p>`,
          buttons: [
            { label: 'Batal', className: 'btn-secondary', onClick: () => Modal.close() },
            {
              label: 'Hapus',
              className: 'btn-danger',
              onClick: async () => {
                try {
                  await pluginManager.uninstall(id);
                  Toast.success('Plugin dihapus.');
                } catch (err) {
                  Toast.error('Gagal menghapus plugin: ' + err.message);
                }
                Modal.close();
                reRender();
              }
            }
          ]
        });
      };
    });
  }
}
