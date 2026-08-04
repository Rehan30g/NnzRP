/* js/ui/views/charactersView.js - AI Character Library & Card Editor (No Emojis) */
import { CharacterStore } from '../../storage/characterStore.js';
import { CardImporter } from '../../services/cardImporter.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

export class CharactersView {
  static async render(container, onStartChat) {
    const characters = await CharacterStore.getAll();

    container.innerHTML = `
      <div class="view-header-row">
        <div>
          <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">AI Character Library</h2>
          <p style="color:var(--text-muted); font-size:0.88rem;">Select a character to start roleplaying, create a new character, or import a Character Card.</p>
        </div>
        <div style="display:flex; gap:0.75rem;">
          <label class="btn btn-secondary btn-sm" style="cursor:pointer;">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
            Import JSON Card
            <input type="file" id="import-card-file" accept=".json" style="display:none;">
          </label>
          <button class="btn btn-primary btn-sm" id="btn-create-character">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"></path></svg>
            Create Character
          </button>
        </div>
      </div>

      <div class="grid-cards">
        ${characters.map(char => `
          <div class="card card-interactive char-card" data-id="${char.id}">
            <div style="display:flex; gap:1rem; align-items:center; margin-bottom:0.8rem;">
              <img src="${escapeAttr(char.avatar)}" class="avatar-img" style="width:54px; height:54px;" onerror="this.src='https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(char.name)}'">
              <div style="flex:1; overflow:hidden;">
                <h3 style="font-size:1.1rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(char.name)}</h3>
                <div style="font-size:0.78rem; color:var(--text-accent); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(char.tagline) || 'AI Roleplay Partner'}</div>
              </div>
            </div>

            <p style="font-size:0.85rem; color:var(--text-muted); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word; overflow-wrap:anywhere; margin-bottom:1rem; min-height:3.8em;">
              ${escapeHtml(char.description) || 'No description provided.'}
            </p>

            <div style="display:flex; flex-wrap:wrap; gap:0.3rem; margin-bottom:1.2rem;">
              ${(char.tags || []).map(t => `<span class="badge">${escapeHtml(t)}</span>`).join('')}
            </div>

            <div style="display:flex; gap:0.5rem; border-top:1px solid var(--border-light); padding-top:0.8rem;">
              <button class="btn btn-primary btn-sm btn-chat-now" data-id="${char.id}" style="flex:1;">
                Start Chat
              </button>
              <button class="btn btn-secondary btn-sm btn-edit-char" data-id="${char.id}">
                Edit
              </button>
              <button class="btn btn-secondary btn-sm btn-export-char" data-id="${char.id}">
                Export
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    // Event Listeners
    container.querySelector('#btn-create-character').onclick = () => {
      this.openCharacterModal(null, async () => this.render(container, onStartChat));
    };

    const importInput = container.querySelector('#import-card-file');
    importInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const result = await CardImporter.parseJSONFile(file);
        if (result.isFullBackup) {
          const s = result.stats;
          Toast.success(`Full Backup imported! Restored: ${s.characters} Characters, ${s.proxies} Proxy Keys, ${s.personas} Personas, ${s.chats} Chats.`);
        } else {
          await CharacterStore.save(result);
          Toast.success(`Character "${result.name}" imported successfully.`);
        }
        this.render(container, onStartChat);
      } catch (err) {
        Toast.error(err.message);
      } finally {
        importInput.value = '';
      }
    };

    container.querySelectorAll('.btn-chat-now').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        onStartChat(btn.dataset.id);
      };
    });

    container.querySelectorAll('.btn-edit-char').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const charId = btn.dataset.id;
        const char = characters.find(c => c.id === charId);
        this.openCharacterModal(char, async () => this.render(container, onStartChat));
      };
    });

    container.querySelectorAll('.btn-export-char').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const char = characters.find(c => c.id === btn.dataset.id);
        if (char) CardImporter.exportToJSON(char);
      };
    });
  }

  static openCharacterModal(character = null, onSaved) {
    const isEdit = !!character;
    const charData = character || {
      name: '',
      tagline: '',
      avatar: '',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      alt_greetings: [],
      example_dialogue: '',
      tags: [],
      lorebooks: []
    };

    const contentHTML = `
      <form id="form-character">
        <div class="form-group">
          <label class="form-label">Character Name *</label>
          <input class="input" id="char-name" value="${escapeAttr(charData.name)}" required placeholder="e.g. Vespera Zenith">
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem;">
          <div class="form-group">
            <label class="form-label">Tagline / Subtitle</label>
            <input class="input" id="char-tagline" value="${escapeAttr(charData.tagline)}" placeholder="e.g. Cyberpunk Rogue Hacker">
          </div>
          <div class="form-group">
            <label class="form-label">Avatar Image URL</label>
            <input class="input" id="char-avatar" value="${escapeAttr(charData.avatar)}" placeholder="https://...">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Character Description</label>
          <textarea class="textarea" id="char-description" placeholder="Brief backstory and summary of the character...">${escapeHtml(charData.description)}</textarea>
        </div>

        <div class="form-group">
          <label class="form-label">Personality Traits</label>
          <textarea class="textarea" id="char-personality" placeholder="Cynical, witty, fiercely independent...">${escapeHtml(charData.personality)}</textarea>
        </div>

        <div class="form-group">
          <label class="form-label">Scenario (Starting Context)</label>
          <textarea class="textarea" id="char-scenario" placeholder="Initial setting where the user and AI meet...">${escapeHtml(charData.scenario)}</textarea>
        </div>

        <div class="form-group">
          <label class="form-label">First Message / Greeting *</label>
          <textarea class="textarea" id="char-first-mes" required placeholder="*She glances up at you...* 'What do you want?'">${escapeHtml(charData.first_mes)}</textarea>
        </div>

        <div class="form-group">
          <label class="form-label">Example Dialogue (&lt;START&gt; format)</label>
          <textarea class="textarea" id="char-example" placeholder="<START>\n<user>: Hello\n<${charData.name || 'Char'}>: *Smirks* Hey there.">${escapeHtml(charData.example_dialogue)}</textarea>
        </div>

        <div class="form-group">
          <label class="form-label">Tags (comma separated)</label>
          <input class="input" id="char-tags" value="${escapeAttr((charData.tags || []).join(', '))}" placeholder="Cyberpunk, Action, Sci-Fi">
        </div>
      </form>
    `;

    Modal.open({
      title: isEdit ? `Edit Character: ${escapeHtml(charData.name)}` : 'Create New AI Character',
      contentHTML,
      buttons: [
        ...(isEdit ? [{
          id: 'btn-delete-char',
          label: 'Delete Character',
          className: 'btn-danger',
          onClick: async () => {
            if (confirm(`Are you sure you want to delete ${charData.name}? All chat sessions for this character will be permanently deleted.`)) {
              await CharacterStore.delete(charData.id);
              Toast.info('Character deleted.');
              Modal.close();
              onSaved();
            }
          }
        }] : []),
        {
          id: 'btn-cancel-char',
          label: 'Cancel',
          className: 'btn-secondary',
          onClick: () => Modal.close()
        },
        {
          id: 'btn-save-char',
          label: 'Save Character',
          className: 'btn-primary',
          onClick: async () => {
            const name = document.getElementById('char-name').value.trim();
            const first_mes = document.getElementById('char-first-mes').value.trim();
            if (!name || !first_mes) {
              Toast.error('Character name and first message are required.');
              return;
            }

            const updatedData = {
              ...charData,
              name,
              tagline: document.getElementById('char-tagline').value.trim(),
              avatar: document.getElementById('char-avatar').value.trim() || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(name)}`,
              description: document.getElementById('char-description').value.trim(),
              personality: document.getElementById('char-personality').value.trim(),
              scenario: document.getElementById('char-scenario').value.trim(),
              first_mes,
              example_dialogue: document.getElementById('char-example').value.trim(),
              tags: document.getElementById('char-tags').value.split(',').map(t => t.trim()).filter(Boolean)
            };

            await CharacterStore.save(updatedData);
            Toast.success('Character saved successfully.');
            Modal.close();
            onSaved();
          }
        }
      ]
    });
  }
}

