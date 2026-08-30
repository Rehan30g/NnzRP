/* js/ui/views/charactersView.js - AI Character Library & Card Editor (No Emojis) */
import { CharacterStore } from '../../storage/characterStore.js';
import { CardImporter } from '../../services/cardImporter.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { pluginManager } from '../../plugins/pluginManager.js';
import { renderAvatarPickerHTML, wireAvatarPicker } from '../components/avatarPicker.js';
import { dropdownHTML, wireDropdown } from '../components/dropdown.js';
import { toggleRowHTML } from '../components/toggle.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

/** Stable, DOM-safe id for one plugin character field input. */
function pluginFieldId(pluginId, key) {
  return 'plugin-field-' + String(`${pluginId}-${key}`).replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Groups the flat `pluginManager.getCharacterFields()` list by contributing
 * plugin, preserving first-seen order. Returns `[]` outside Electron
 * (getCharacterFields() is empty there).
 */
function groupPluginCharacterFields() {
  if (!pluginManager.isSupported()) return [];
  const groups = [];
  for (const f of pluginManager.getCharacterFields()) {
    let g = groups.find(x => x.pluginId === f.pluginId);
    if (!g) {
      g = { pluginId: f.pluginId, pluginName: f.pluginName || f.pluginId, fields: [] };
      groups.push(g);
    }
    g.fields.push(f);
  }
  return groups;
}

/**
 * Form section markup for the plugin-contributed character fields. All
 * manifest-supplied text (plugin name, field label/help/placeholder, select
 * option labels) is untrusted and escaped. Current values come from
 * `character.pluginData[pluginId][key]`.
 */
function pluginFieldSectionsHTML(groups, character) {
  if (!groups.length) return '';
  const pd = (character && character.pluginData && typeof character.pluginData === 'object') ? character.pluginData : {};
  return groups.map(g => {
    // Raw stored value (may be `false`, `0`, `''` - all meaningful for a
    // toggle) vs. the string-coerced form used by text/select inputs.
    const rawCur = (key) => (pd[g.pluginId] ? pd[g.pluginId][key] : undefined);
    const isUnset = (v) => v === undefined || v === null || v === '';
    const cur = (key) => {
      const v = rawCur(key);
      return isUnset(v) ? '' : v;
    };
    return `
      <div class="plugin-scope" style="border-top:1px solid var(--border-light); margin-top:1rem; padding-top:1rem;">
        <div class="form-label" style="font-weight:700; margin-bottom:0.75rem;">${escapeHtml(g.pluginName)}</div>
        ${g.fields.map(f => {
          const id = pluginFieldId(g.pluginId, f.key);
          const help = f.help ? `<span class="form-hint">${escapeHtml(f.help)}</span>` : '';
          if (f.type === 'toggle') {
            const v = rawCur(f.key);
            // No stored value yet -> honour the field's declared default
            // (a plugin toggle that should start ON must say so).
            const checked = isUnset(v) ? !!f.default : (v === true || v === 'true');
            return toggleRowHTML({
              id,
              checked,
              title: escapeHtml(f.label || f.key),
              description: f.help ? escapeHtml(f.help) : ''
            });
          }
          if (f.type === 'select') {
            const options = (f.options || []).map(o => (typeof o === 'string'
              ? { value: o, label: o }
              : { value: o.value, label: o.label ?? o.value }));
            const selVal = cur(f.key) || (f.default != null ? String(f.default) : '');
            return `
              <div class="form-group">
                <label class="form-label">${escapeHtml(f.label || f.key)}</label>
                ${dropdownHTML({ id, options, value: String(selVal), placeholder: f.placeholder || 'Select...' })}
                ${help}
              </div>`;
          }
          if (f.type === 'textarea') {
            return `
              <div class="form-group">
                <label class="form-label">${escapeHtml(f.label || f.key)}</label>
                <textarea class="textarea" id="${escapeAttr(id)}" placeholder="${escapeAttr(f.placeholder || '')}">${escapeHtml(cur(f.key) || (f.default != null ? String(f.default) : ''))}</textarea>
                ${help}
              </div>`;
          }
          return `
            <div class="form-group">
              <label class="form-label">${escapeHtml(f.label || f.key)}</label>
              <input class="input" id="${escapeAttr(id)}" value="${escapeAttr(cur(f.key) || (f.default != null ? String(f.default) : ''))}" placeholder="${escapeAttr(f.placeholder || '')}">
              ${help}
            </div>`;
        }).join('')}
      </div>
    `;
  }).join('');
}

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
            Import Card
            <input type="file" id="import-card-file" accept=".json" style="display:none;">
          </label>
          <button class="btn btn-primary btn-sm" id="btn-create-character">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"></path></svg>
            Create
          </button>
        </div>
      </div>

      <div class="grid-cards">
        ${characters.map(char => `
          <div class="card card-interactive char-card" data-id="${char.id}">
            <div style="display:flex; gap:1rem; align-items:center; margin-bottom:0.8rem;">
              <img src="${escapeAttr(char.avatar)}" class="avatar-img" style="width:54px; height:54px;" onerror="this.src='https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(char.name).replace(/'/g, '%27')}'">
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
      btn.onclick = async (e) => {
        e.stopPropagation();
        const char = characters.find(c => c.id === btn.dataset.id);
        if (!char) return;
        try {
          await CardImporter.exportToJSON(char);
        } catch (err) {
          Toast.error('Export failed: ' + err.message);
        }
      };
    });
  }

  static openCharacterModal(character = null, onSaved) {
    const isEdit = !!character;
    const pluginFieldGroups = groupPluginCharacterFields();
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

        <div class="form-group">
          <label class="form-label">Tagline / Subtitle</label>
          <input class="input" id="char-tagline" value="${escapeAttr(charData.tagline)}" placeholder="e.g. Cyberpunk Rogue Hacker">
        </div>

        ${renderAvatarPickerHTML('char-avatar', charData.avatar)}

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
          <textarea class="textarea" id="char-example" placeholder="<START>\n<user>: Hello\n<${escapeAttr(charData.name || 'Char')}>: *Smirks* Hey there.">${escapeHtml(charData.example_dialogue)}</textarea>
        </div>

        <div class="form-group">
          <label class="form-label">Tags (comma separated)</label>
          <input class="input" id="char-tags" value="${escapeAttr((charData.tags || []).join(', '))}" placeholder="Cyberpunk, Action, Sci-Fi">
        </div>

        ${pluginFieldSectionsHTML(pluginFieldGroups, character)}
      </form>
    `;

    const overlay = Modal.open({
      title: isEdit ? `Edit Character: ${escapeHtml(charData.name)}` : 'Create New AI Character',
      contentHTML,
      buttons: [
        ...(isEdit ? [{
          id: 'btn-delete-char',
          label: 'Delete',
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
          label: 'Save',
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

            // Collect plugin-contributed fields into pluginData[pluginId][key],
            // merging onto whatever other plugins already stored so nothing
            // else's data is wiped. `updatedData` already spreads charData, so
            // charData.pluginData carries through untouched for plugins with no
            // field on this form.
            if (pluginFieldGroups.length) {
              const existing = (charData.pluginData && typeof charData.pluginData === 'object') ? charData.pluginData : {};
              const pluginData = { ...existing };
              for (const g of pluginFieldGroups) {
                pluginData[g.pluginId] = { ...(existing[g.pluginId] || {}) };
                for (const f of g.fields) {
                  const el = document.getElementById(pluginFieldId(g.pluginId, f.key));
                  if (!el) continue;
                  pluginData[g.pluginId][f.key] = f.type === 'toggle' ? !!el.checked : el.value;
                }
              }
              updatedData.pluginData = pluginData;
            }

            await CharacterStore.save(updatedData);
            Toast.success('Character saved successfully.');
            Modal.close();
            onSaved();
          }
        }
      ]
    });

    wireAvatarPicker(overlay, 'char-avatar');

    // Activate custom dropdowns for any plugin `select` fields (scoped to the
    // modal overlay, same as wireAvatarPicker above).
    for (const g of pluginFieldGroups) {
      for (const f of g.fields) {
        if (f.type === 'select') wireDropdown(overlay, pluginFieldId(g.pluginId, f.key));
      }
    }
  }
}

