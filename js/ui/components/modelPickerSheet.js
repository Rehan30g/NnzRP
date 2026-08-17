/* js/ui/components/modelPickerSheet.js - Mobile bottom-sheet model/provider
   picker for the chat composer (js/ui/views/chatView.js).

   Desktop keeps the existing js/ui/components/dropdown.js picker with its
   own inline "Switch Provider" drill-down (see chatView.js's
   populateModelSelect). This is the mobile-only equivalent - chatView.js
   opens this instead of the dropdown whenever window.innerWidth <= 768 at
   tap time (matches the app's existing CSS mobile breakpoint). Both paths
   end up calling the exact same selection logic in chatView.js
   (proxy.selectedModel = value / proxy.isDefault = true), so behavior is
   identical between desktop and mobile - only the picker UI differs.

   Single-instance (not stacked like Modal.js) - only one of these is ever
   meaningful open at a time, unlike Modal's nested-dialog use cases.
   ============================================================================ */
import { escapeHtml } from '../../utils/sanitize.js';
import { attachSheetDragToClose, dismissSheet } from './sheetGesture.js';

const CHECK_SVG =
  '<svg class="model-picker-sheet-check" width="18" height="18" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">' +
  '<polyline points="20 6 9 17 4 12"></polyline></svg>';

let activeOverlay = null;
let detachDrag = null;

/** Detaches the drag gesture and rips the overlay out - no animation. Used
 * both as the final step of the animated `closeSheet()` below, and directly
 * wherever a previous instance just needs to be gone instantly (a fresh
 * `openModelPickerSheet()` call replacing it - see below - would otherwise
 * visibly overlap its own exit animation with the new sheet's entrance). */
function finalizeClose() {
  if (detachDrag) {
    try { detachDrag(); } catch { /* nothing to unwind */ }
    detachDrag = null;
  }
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
}

/** User-facing close (backdrop tap, close button, picking a row) - always
 * plays the same slide-down/fade-out as a drag-release dismiss before
 * actually removing anything, so every way of leaving the sheet feels the
 * same instead of only the drag gesture animating. */
function closeSheet() {
  if (!activeOverlay) return;
  const overlay = activeOverlay;
  const contentEl = overlay.querySelector('.model-picker-sheet-content');
  if (contentEl) {
    dismissSheet({ sheetEl: contentEl, overlayEl: overlay, onDismiss: finalizeClose });
  } else {
    finalizeClose();
  }
}

/**
 * @param {object} opts
 * @param {Array<{value:string,label:string,active:boolean}>} opts.models
 * @param {string} opts.currentProxyName
 * @param {Array<{id:string,name:string,hint:string}>} opts.proxies - every
 *   configured proxy (current one included is fine); empty/single-item
 *   hides the "Switch Provider" row entirely (nothing to switch to).
 * @param {(modelValue:string) => void} opts.onSelectModel
 * @param {(proxyId:string) => void} opts.onSelectProvider
 */
export function openModelPickerSheet({ models, currentProxyName, proxies = [], onSelectModel, onSelectProvider }) {
  finalizeClose(); // instant - replacing a previous instance, not a user dismiss

  const overlay = document.createElement('div');
  overlay.className = 'model-picker-sheet-overlay';
  overlay.innerHTML = `
    <div class="model-picker-sheet-content">
      <div class="sheet-drag-handle" aria-hidden="true"></div>
      <div class="model-picker-sheet-header">
        <button type="button" class="btn-icon" id="model-picker-close-btn" aria-label="Close">&times;</button>
        <h3 id="model-picker-sheet-title">Pilih model</h3>
        <span class="model-picker-sheet-header-spacer"></span>
      </div>
      <div class="model-picker-sheet-body" id="model-picker-sheet-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  overlay.onclick = (e) => {
    if (e.target === overlay) closeSheet();
  };
  overlay.querySelector('#model-picker-close-btn').onclick = () => closeSheet();

  // Swipe-down-to-dismiss from the grab handle. Purely additive: the backdrop
  // tap above and the close button on the line above both keep working exactly
  // as before, and attachSheetDragToClose() returns a no-op if either element
  // is somehow missing.
  // Drag-release already plays its own slide-down/fade-out (see
  // attachSheetDragToClose's overlayEl param) before calling onDismiss, so
  // this wires straight to finalizeClose - going through closeSheet() here
  // would animate a second time on top of an already-finished animation.
  detachDrag = attachSheetDragToClose({
    sheetEl: overlay.querySelector('.model-picker-sheet-content'),
    handleEl: overlay.querySelector('.sheet-drag-handle'),
    overlayEl: overlay,
    onDismiss: finalizeClose
  });

  const titleEl = overlay.querySelector('#model-picker-sheet-title');
  const bodyEl = overlay.querySelector('#model-picker-sheet-body');

  function renderModels() {
    titleEl.textContent = 'Pilih model';

    const modelRows = models.map(m => `
      <button type="button" class="model-picker-sheet-option" data-model="${escapeHtml(m.value)}">
        <span class="model-picker-sheet-option-label">${escapeHtml(m.label)}</span>
        ${m.active ? CHECK_SVG : ''}
      </button>
    `).join('');

    const providerRow = proxies.length > 1 ? `
      <div class="model-picker-sheet-group-gap"></div>
      <button type="button" class="model-picker-sheet-option" id="model-picker-switch-provider">
        <span class="model-picker-sheet-option-text">
          <span class="model-picker-sheet-option-label">Switch Provider</span>
          <span class="model-picker-sheet-option-hint">Currently: ${escapeHtml(currentProxyName)}</span>
        </span>
        <span class="model-picker-sheet-chevron">&rsaquo;</span>
      </button>
    ` : '';

    bodyEl.innerHTML = `<div class="model-picker-sheet-group">${modelRows}</div>${providerRow}`;

    bodyEl.querySelectorAll('[data-model]').forEach(btn => {
      btn.onclick = () => {
        closeSheet();
        onSelectModel(btn.dataset.model);
      };
    });
    const switchBtn = bodyEl.querySelector('#model-picker-switch-provider');
    if (switchBtn) switchBtn.onclick = renderProviders;
  }

  function renderProviders() {
    titleEl.textContent = 'Pilih provider';

    const rows = proxies.map(p => `
      <button type="button" class="model-picker-sheet-option" data-proxy="${escapeHtml(p.id)}">
        <span class="model-picker-sheet-option-text">
          <span class="model-picker-sheet-option-label">${escapeHtml(p.name)}</span>
          <span class="model-picker-sheet-option-hint">${escapeHtml(p.hint || '')}</span>
        </span>
      </button>
    `).join('');

    bodyEl.innerHTML = `
      <div class="model-picker-sheet-group">${rows}</div>
      <button type="button" class="model-picker-sheet-option model-picker-sheet-back" id="model-picker-back">
        <span class="model-picker-sheet-chevron-back">&lsaquo;</span>
        <span class="model-picker-sheet-option-label">Kembali ke model</span>
      </button>
    `;

    bodyEl.querySelector('#model-picker-back').onclick = renderModels;
    bodyEl.querySelectorAll('[data-proxy]').forEach(btn => {
      btn.onclick = () => {
        closeSheet();
        onSelectProvider(btn.dataset.proxy);
      };
    });
  }

  renderModels();
}
