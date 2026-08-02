/* js/ui/components/modal.js - Dynamic Reusable Modal Component (Stacked) */

export class Modal {
  // Stack of currently open overlay elements - supports nesting (a modal opened
  // from inside another modal's contentHTML no longer clobbers the one beneath it).
  static stack = [];

  static open({ title, contentHTML, buttons = [], onClose }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = 1000 + this.stack.length;

    const buttonsHTML = buttons.map(b => `
      <button class="btn ${b.className || 'btn-secondary'}" id="${b.id}">${b.label}</button>
    `).join('');

    overlay.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>${title}</h3>
          <button class="btn-icon" id="modal-close-btn">&times;</button>
        </div>
        <div class="modal-body">
          ${contentHTML}
        </div>
        ${buttons.length ? `<div class="modal-footer">${buttonsHTML}</div>` : ''}
      </div>
    `;

    document.body.appendChild(overlay);
    this.stack.push(overlay);

    // Event listeners - only close THIS overlay (the one on top), not the whole stack
    const closeBtn = overlay.querySelector('#modal-close-btn');
    closeBtn.onclick = () => {
      this.closeOverlay(overlay);
      if (onClose) onClose();
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        this.closeOverlay(overlay);
        if (onClose) onClose();
      }
    };

    buttons.forEach(b => {
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
    overlay.remove();
  }

  /** Closes the topmost open modal (backward-compatible default). */
  static close() {
    const top = this.stack.pop();
    if (top) top.remove();
  }

  /** Closes every open modal in the stack. */
  static closeAll() {
    while (this.stack.length) {
      const top = this.stack.pop();
      top.remove();
    }
  }
}
