/* js/ui/components/toast.js - Notification Toast Manager (No Emojis) */
import { escapeHtml } from '../../utils/sanitize.js';

export class Toast {
  static getContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  static show(message, type = 'info', duration = 2200) {
    const container = this.getContainer();

    // Phone-style: only one banner at a time. A new one replaces whatever is
    // currently showing/animating instead of stacking below it.
    if (this._activeTimeout) clearTimeout(this._activeTimeout);
    if (this._activeToast) this._activeToast.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let label = 'INFO';
    if (type === 'success') label = 'SUCCESS';
    if (type === 'error') label = 'ERROR';

    toast.innerHTML = `
      <span class="badge badge-${type === 'success' ? 'emerald' : (type === 'error' ? 'rose' : 'cyan')}">${label}</span>
      <span class="toast-message">${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    this._activeToast = toast;

    // Force layout so the enter transition actually plays instead of being
    // coalesced with the initial (hidden) state.
    void toast.offsetHeight;
    toast.classList.add('toast-visible');

    this._activeTimeout = setTimeout(() => {
      toast.classList.remove('toast-visible');
      toast.classList.add('toast-leaving');
      setTimeout(() => {
        toast.remove();
        if (this._activeToast === toast) this._activeToast = null;
      }, 160);
    }, duration);
  }

  static success(msg) { this.show(msg, 'success'); }
  static error(msg) { this.show(msg, 'error'); }
  static info(msg) { this.show(msg, 'info'); }
}
