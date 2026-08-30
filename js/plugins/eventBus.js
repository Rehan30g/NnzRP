/* js/plugins/eventBus.js - Tiny synchronous event emitter for the plugin system
   ============================================================================
   Deliberately minimal: no wildcard matching, no async, no priority. `emit()`
   NEVER throws - every listener runs inside its own try/catch so one broken
   plugin handler can't stop the others or bubble up into app code. Listener
   errors are logged with the `label` passed to the constructor so it's obvious
   which bus (which plugin) misbehaved.
   ============================================================================ */

export class EventBus {
  /** @param {string} [label] - prefix used when logging a listener error. */
  constructor(label = 'EventBus') {
    this.label = label;
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe `fn` to `event`.
   * @returns {() => void} a disposer that removes exactly this subscription.
   */
  on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  /** Remove a previously registered listener. */
  off(event, fn) {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(fn);
    if (!set.size) this._listeners.delete(event);
  }

  /**
   * Subscribe `fn` to fire at most once.
   * @returns {() => void} a disposer (usable before the event ever fires).
   */
  once(event, fn) {
    if (typeof fn !== 'function') return () => {};
    const wrapper = (payload) => {
      this.off(event, wrapper);
      fn(payload);
    };
    return this.on(event, wrapper);
  }

  /**
   * Synchronously invoke every listener for `event`. Iterates a copy of the
   * listener set so a handler that (un)subscribes during dispatch is safe.
   * Never throws.
   */
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || !set.size) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[${this.label}] listener error for "${event}"`, e);
      }
    }
  }

  /** Drop every listener on this bus (used on plugin teardown). */
  clear() {
    this._listeners.clear();
  }
}
