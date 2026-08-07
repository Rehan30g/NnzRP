/* js/ui/components/toggle.js - Reusable toggle-switch markup helper
   =================================================================
   Every boolean setting in the app renders through this instead of a bare
   `<input type="checkbox">`.

   IMPORTANT: this is a VISUAL wrapper only. The real `<input type="checkbox">`
   is still there, keeps its `id`, its extra classes, its `data-*` attributes
   and its `.checked` property - so every existing
   `container.querySelector('#x').checked` read and `.onchange = ...` handler
   in the views keeps working untouched, and keyboard/screen-reader behaviour
   stays native. Styling lives in `.toggle-switch` / `.toggle-track` in
   css/components.css.
   ================================================================= */
import { escapeAttr } from '../../utils/sanitize.js';

/**
 * @param {object}  opts
 * @param {string}  [opts.id]          - id for the underlying checkbox
 * @param {string}  [opts.inputClass]  - extra class(es) on the checkbox (e.g. 'mcp-enabled-check')
 * @param {boolean} [opts.checked]
 * @param {boolean} [opts.disabled]
 * @param {string}  [opts.title]       - tooltip, applied to the wrapping label
 * @param {string}  [opts.ariaLabel]
 * @param {object}  [opts.data]        - data-* attributes for the checkbox, e.g. { id: server.id }
 * @param {boolean} [opts.small]       - compact variant for dense list rows
 * @returns {string} HTML string
 */
export function toggleSwitchHTML({
  id = '',
  inputClass = '',
  checked = false,
  disabled = false,
  title = '',
  ariaLabel = '',
  data = {},
  small = false
} = {}) {
  const dataAttrs = Object.entries(data)
    .map(([k, v]) => ` data-${escapeAttr(k)}="${escapeAttr(v)}"`)
    .join('');

  return `<label class="toggle-switch${small ? ' toggle-sm' : ''}"${title ? ` title="${escapeAttr(title)}"` : ''}>` +
    `<input type="checkbox"` +
    `${id ? ` id="${escapeAttr(id)}"` : ''}` +
    `${inputClass ? ` class="${escapeAttr(inputClass)}"` : ''}` +
    `${checked ? ' checked' : ''}` +
    `${disabled ? ' disabled' : ''}` +
    `${ariaLabel ? ` aria-label="${escapeAttr(ariaLabel)}"` : (title ? ` aria-label="${escapeAttr(title)}"` : '')}` +
    `${dataAttrs}>` +
    `<span class="toggle-track"></span>` +
    `</label>`;
}

/**
 * Convenience wrapper: a full "title + description on the left, switch on the
 * right" settings row. `title`/`description` are raw HTML strings so callers can
 * embed already-escaped dynamic text (every current call site pre-escapes with
 * escapeHtml, same convention as Modal.open's contentHTML).
 */
export function toggleRowHTML({ title, description = '', ...toggleOpts }) {
  return `
    <div class="toggle-row">
      <div class="toggle-row-text">
        <div class="toggle-row-title">${title}</div>
        ${description ? `<div class="toggle-row-desc">${description}</div>` : ''}
      </div>
      ${toggleSwitchHTML(toggleOpts)}
    </div>
  `;
}
