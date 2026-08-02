/* js/ui/views/personasView.js - User Player Persona Management */
import { PersonaStore } from '../../storage/personaStore.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

export class PersonasView {
  static async render(container) {
    const personas = await PersonaStore.getAll();

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
        <div>
          <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">User Personas</h2>
          <p style="color:var(--text-muted); font-size:0.88rem;">Buat profil karakter pemain Anda untuk dimainkan saat roleplay dengan AI.</p>
        </div>
        <button class="btn btn-primary btn-sm" id="btn-create-persona">
          + Buat Persona Baru
        </button>
      </div>

      <div class="grid-cards">
        ${personas.map(p => `
          <div class="card card-interactive" style="border-color:${p.isDefault ? 'var(--accent-primary)' : 'var(--border-light)'}; position:relative;">
            ${p.isDefault ? `<span class="badge badge-emerald" style="position:absolute; top:12px; right:12px;">Aktif Default</span>` : ''}
            <div style="display:flex; gap:1rem; align-items:center; margin-bottom:1rem;">
              <img src="${escapeAttr(p.avatar)}" class="avatar-img" style="width:50px; height:50px;" onerror="this.src='https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(p.name)}'">
              <div>
                <h3 style="font-size:1.1rem;">${escapeHtml(p.name)}</h3>
                <div style="font-size:0.75rem; color:var(--text-muted);">Player Character</div>
              </div>
            </div>

            <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:1.2rem; min-height:2.5em;">
              ${escapeHtml(p.description) || 'Tidak ada deskripsi.'}
            </p>

            <div style="display:flex; gap:0.5rem; border-top:1px solid var(--border-light); padding-top:0.8rem;">
              ${!p.isDefault ? `
                <button class="btn btn-secondary btn-sm btn-set-default" data-id="${p.id}" style="flex:1;">
                  Set default
                </button>
              ` : ''}
              <button class="btn btn-secondary btn-sm btn-edit-persona" data-id="${p.id}">
                Edit
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    container.querySelector('#btn-create-persona').onclick = () => {
      this.openPersonaModal(null, () => this.render(container));
    };

    container.querySelectorAll('.btn-set-default').forEach(btn => {
      btn.onclick = async () => {
        const persona = await PersonaStore.getById(btn.dataset.id);
        if (persona) {
          persona.isDefault = true;
          await PersonaStore.save(persona);
          Toast.success(`Persona "${persona.name}" diset sebagai default.`);
          this.render(container);
        }
      };
    });

    container.querySelectorAll('.btn-edit-persona').forEach(btn => {
      btn.onclick = async () => {
        const persona = await PersonaStore.getById(btn.dataset.id);
        this.openPersonaModal(persona, () => this.render(container));
      };
    });
  }

  static openPersonaModal(persona = null, onSaved) {
    const isEdit = !!persona;
    const data = persona || { name: '', description: '', avatar: '', isDefault: false };

    const contentHTML = `
      <form id="form-persona">
        <div class="form-group">
          <label class="form-label">Nama Player Persona *</label>
          <input class="input" id="persona-name" value="${escapeAttr(data.name)}" required placeholder="misal: Detective Miller / Adventurer">
        </div>

        <div class="form-group">
          <label class="form-label">Avatar Image URL</label>
          <input class="input" id="persona-avatar" value="${escapeAttr(data.avatar)}" placeholder="https://...">
        </div>

        <div class="form-group">
          <label class="form-label">Deskripsi / Background Bio Karakter Anda</label>
          <textarea class="textarea" id="persona-desc" placeholder="Penjelasan singkat latar belakang karakter Anda yang akan dibaca oleh AI...">${escapeHtml(data.description)}</textarea>
        </div>

        <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.5rem;">
          <input type="checkbox" id="persona-default" ${data.isDefault ? 'checked' : ''}>
          <label for="persona-default" style="font-size:0.85rem; cursor:pointer;">Jadikan sebagai Player Persona Default</label>
        </div>
      </form>
    `;

    Modal.open({
      title: isEdit ? `Edit Persona: ${escapeHtml(data.name)}` : 'Buat Persona Baru',
      contentHTML,
      buttons: [
        ...(isEdit ? [{
          id: 'btn-del-persona',
          label: 'Hapus',
          className: 'btn-danger',
          onClick: async () => {
            await PersonaStore.delete(data.id);
            Toast.info('Persona terhapus.');
            Modal.close();
            onSaved();
          }
        }] : []),
        {
          id: 'btn-cancel-p',
          label: 'Batal',
          className: 'btn-secondary',
          onClick: () => Modal.close()
        },
        {
          id: 'btn-save-p',
          label: 'Simpan',
          className: 'btn-primary',
          onClick: async () => {
            const name = document.getElementById('persona-name').value.trim();
            if (!name) return Toast.error('Nama persona wajib diisi!');

            await PersonaStore.save({
              ...data,
              name,
              avatar: document.getElementById('persona-avatar').value.trim() || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(name)}`,
              description: document.getElementById('persona-desc').value.trim(),
              isDefault: document.getElementById('persona-default').checked
            });

            Toast.success('Persona tersimpan!');
            Modal.close();
            onSaved();
          }
        }
      ]
    });
  }
}
