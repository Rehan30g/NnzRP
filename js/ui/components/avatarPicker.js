/* js/ui/components/avatarPicker.js - Character/Persona Avatar Image Picker (URL or local upload) */
import { escapeAttr } from '../../utils/sanitize.js';
import { Toast } from './toast.js';

// Keeps IndexedDB from bloating with huge uploads - base64 data: URLs run
// ~33% bigger than the original file, so 3MB here is generous for an avatar.
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

/**
 * Renders the "Via URL" / "Upload Image" toggle plus both input rows for an
 * avatar field. `idPrefix` namespaces every element id (e.g. `char-avatar` ->
 * `#char-avatar`, `#char-avatar-url-row`, `#char-avatar-file`, ...) so
 * charactersView.js and personasView.js can each embed this inside their own
 * modal form without id collisions.
 *
 * Both modes ultimately write to the SAME text input (`#${idPrefix}`) - an
 * uploaded file is read as a base64 `data:` URL and written there via
 * `wireAvatarPicker` below, so existing save handlers that already do
 * `document.getElementById(idPrefix).value.trim()` need no changes to
 * support both URL and local-upload avatars.
 */
export function renderAvatarPickerHTML(idPrefix, currentValue = '') {
  const isUpload = typeof currentValue === 'string' && currentValue.startsWith('data:');
  return `
    <div class="form-group">
      <label class="form-label">Avatar Image</label>
      <div style="display:flex; gap:0.4rem; margin-bottom:0.6rem;">
        <button type="button" class="btn btn-sm ${isUpload ? 'btn-secondary' : 'btn-primary'} avatar-mode-btn" data-target="${idPrefix}" data-mode="url" style="flex:1;">Via URL</button>
        <button type="button" class="btn btn-sm ${isUpload ? 'btn-primary' : 'btn-secondary'} avatar-mode-btn" data-target="${idPrefix}" data-mode="upload" style="flex:1;">Upload Image</button>
      </div>
      <div id="${idPrefix}-url-row" style="${isUpload ? 'display:none;' : ''}">
        <input class="input" id="${idPrefix}" value="${escapeAttr(currentValue)}" placeholder="https://...">
      </div>
      <div id="${idPrefix}-upload-row" style="display:${isUpload ? 'flex' : 'none'}; align-items:center; gap:0.75rem;">
        <img id="${idPrefix}-preview" src="${escapeAttr(currentValue)}" alt="" style="width:56px; height:56px; border-radius:10px; object-fit:cover; border:1px solid var(--border-light); background:#f1f5f9;">
        <input type="file" accept="image/*" id="${idPrefix}-file" style="flex:1;">
      </div>
      <p style="font-size:0.72rem; color:var(--text-muted); margin-top:0.4rem;">Uploaded images are stored locally in the app's own database - nothing is sent anywhere.</p>
    </div>
  `;
}

/**
 * Wires the toggle buttons + file upload for a picker built by
 * `renderAvatarPickerHTML(idPrefix, ...)`. Call once the markup is actually
 * in the DOM (e.g. right after `Modal.open()` returns its overlay).
 */
export function wireAvatarPicker(scopeEl, idPrefix) {
  const urlRow = scopeEl.querySelector(`#${idPrefix}-url-row`);
  const uploadRow = scopeEl.querySelector(`#${idPrefix}-upload-row`);
  const textInput = scopeEl.querySelector(`#${idPrefix}`);
  const preview = scopeEl.querySelector(`#${idPrefix}-preview`);
  const fileInput = scopeEl.querySelector(`#${idPrefix}-file`);
  if (!urlRow || !uploadRow || !textInput || !fileInput) return;

  scopeEl.querySelectorAll(`.avatar-mode-btn[data-target="${idPrefix}"]`).forEach(btn => {
    btn.onclick = () => {
      const mode = btn.dataset.mode;
      scopeEl.querySelectorAll(`.avatar-mode-btn[data-target="${idPrefix}"]`).forEach(b => {
        b.classList.toggle('btn-primary', b.dataset.mode === mode);
        b.classList.toggle('btn-secondary', b.dataset.mode !== mode);
      });
      urlRow.style.display = mode === 'url' ? '' : 'none';
      uploadRow.style.display = mode === 'upload' ? 'flex' : 'none';
    };
  });

  fileInput.onchange = () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      Toast.error('Please select an image file.');
      fileInput.value = '';
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      Toast.error('Image is too large (max 3MB).');
      fileInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      textInput.value = reader.result;
      if (preview) preview.src = reader.result;
    };
    reader.onerror = () => Toast.error('Failed to read image file.');
    reader.readAsDataURL(file);
  };
}
