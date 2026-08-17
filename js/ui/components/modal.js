/* js/ui/components/modal.js - Dynamic Reusable Modal Component (Stacked)
   ============================================================================
   Mobile (<=768px, css/components.css's mobile block): every modal already
   renders as a bottom sheet (slideUpMobile entry, rounded top corners,
   bottom-anchored). This file adds the other half of that: a grab handle +
   swipe-down-to-dismiss (js/ui/components/sheetGesture.js, the same module
   the chat right-drawer and the model-picker sheet use), and an animated
   slide-down/fade-out exit on EVERY close path - not just the drag gesture -
   so backdrop tap / the X button / a form's own Cancel button all leave the
   same way instead of only a drag looking intentional and everything else
   just vanishing. Desktop (centered dialog) is untouched: the handle is
   display:none there (a display:none element receives no pointer events, so
   the gesture itself never engages), and closes stay instant.

   The drag gesture is wired for EVERY modal regardless of `closeOnBackdropClick`
   (which stays exactly as strict as before - a form that disables backdrop-tap-
   close to protect an in-progress draft still does). A deliberate swipe on the
   handle is a much more intentional action than an accidental tap outside the
   card, so it doesn't carry the same "lost my unsaved edits by mistake" risk
   that backdrop-tap-close was guarding against.
   ============================================================================ */
import { attachSheetDragToClose, dismissSheet } from './sheetGesture.js';

export class Modal {
  // Stack of currently open overlay elements - supports nesting (a modal opened
  // from inside another modal's contentHTML no longer clobbers the one beneath it).
  static stack = [];

  static open({ title, contentHTML, buttons = [], onClose, closeOnBackdropClick = false }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = 1000 + this.stack.length;

    const resolvedButtons = buttons.map((b, i) => ({
      ...b,
      id: b.id || `modal-btn-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 4)}`
    }));

    const buttonsHTML = resolvedButtons.map(b => `
      <button class="btn ${b.className || 'btn-secondary'}" id="${b.id}">${b.label}</button>
    `).join('');

    overlay.innerHTML = `
      <div class="modal-content">
        <div class="sheet-drag-handle" aria-hidden="true"></div>
        <div class="modal-header">
          <h3>${title}</h3>
          <button class="btn-icon" id="modal-close-btn">&times;</button>
        </div>
        <div class="modal-body">
          ${contentHTML}
        </div>
        ${resolvedButtons.length ? `<div class="modal-footer">${buttonsHTML}</div>` : ''}
      </div>
    `;

    document.body.appendChild(overlay);
    this.stack.push(overlay);

    // Drag-release plays its own slide-down/fade-out (via `overlayEl` below)
    // before calling onDismiss, so this wires straight to the no-animation
    // finalize step - routing it back through closeOverlay()/_dismissVisual
    // here would animate a second time on top of an already-finished one.
    // display:none on desktop (css/components.css) means the handle receives
    // no pointer events there, so this gesture simply never engages.
    overlay._detachSheetDrag = attachSheetDragToClose({
      sheetEl: overlay.querySelector('.modal-content'),
      handleEl: overlay.querySelector('.sheet-drag-handle'),
      overlayEl: overlay,
      onDismiss: () => {
        const idx = this.stack.indexOf(overlay);
        if (idx !== -1) this.stack.splice(idx, 1);
        this._finalizeRemoval(overlay);
      }
    });

    // Event listeners - only close THIS overlay (the one on top), not the whole stack
    const closeBtn = overlay.querySelector('#modal-close-btn');
    closeBtn.onclick = () => {
      this.closeOverlay(overlay);
      if (onClose) onClose();
    };

    // Only close on backdrop click if explicitly enabled (default is false to prevent accidental progress loss)
    if (closeOnBackdropClick) {
      overlay.onclick = (e) => {
        if (e.target === overlay) {
          this.closeOverlay(overlay);
          if (onClose) onClose();
        }
      };
    }

    resolvedButtons.forEach(b => {
      const btnEl = overlay.querySelector(`#${b.id}`);
      if (btnEl && b.onClick) {
        btnEl.onclick = () => b.onClick(overlay);
      }
    });

    return overlay;
  }

  static closeOverlay(overlay) {
    const idx = this.stack.indexOf(overlay);
    if (idx !== -1) this.stack.splice(idx, 1);
    this._dismissVisual(overlay);
  }

  /** Closes the topmost open modal (backward-compatible default). */
  static close() {
    const top = this.stack.pop();
    if (top) this._dismissVisual(top);
  }

  /** Closes every open modal in the stack. */
  static closeAll() {
    while (this.stack.length) {
      const top = this.stack.pop();
      this._dismissVisual(top);
    }
  }

  /** Plays the mobile slide-down/fade-out exit before removing `overlay` from
   * the DOM (desktop: removes it immediately - no slide-in to reverse there).
   * Stack bookkeeping is the caller's job (closeOverlay/close/closeAll above),
   * this only ever handles the visual/DOM side. */
  static _dismissVisual(overlay) {
    const contentEl = overlay.querySelector('.modal-content');
    if (window.innerWidth <= 768 && contentEl && overlay.isConnected) {
      dismissSheet({ sheetEl: contentEl, overlayEl: overlay, onDismiss: () => this._finalizeRemoval(overlay) });
    } else {
      this._finalizeRemoval(overlay);
    }
  }

  static _finalizeRemoval(overlay) {
    if (overlay._detachSheetDrag) {
      overlay._detachSheetDrag();
      overlay._detachSheetDrag = null;
    }
    overlay.remove();
  }
}
