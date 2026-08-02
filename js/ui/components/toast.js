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

  static show(message, type = 'info', duration = 3500) {
    const container = this.getContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let label = 'INFO';
    if (type === 'success') label = 'SUCCESS';
    if (type === 'error') label = 'ERROR';

    toast.innerHTML = `
      <span class="badge badge-${type === 'success' ? 'emerald' : (type === 'error' ? 'rose' : 'cyan')}">${label}</span>
      <span style="flex:1; font-size:0.85rem;">${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  static success(msg) { this.show(msg, 'success'); }
  static error(msg) { this.show(msg, 'error'); }
  static info(msg) { this.show(msg, 'info'); }
}
