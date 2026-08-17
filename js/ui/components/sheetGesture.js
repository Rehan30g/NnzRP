/* js/ui/components/sheetGesture.js - Swipe-down-to-dismiss for the app's
   mobile bottom sheets (the chat right-drawer, the model-picker sheet, and
   every Modal.js dialog on mobile).

   WHY A SHARED MODULE: both sheets already share the same look and the same
   `slideUpMobile` entry keyframe (css/chat.css); they should share the same
   exit gesture too, with identical thresholds, rather than growing two
   slightly-different hand-rolled copies.

   WHY POINTER EVENTS (not touch events): one code path covers finger, stylus
   and mouse, and `setPointerCapture`-free window listeners mean a finger that
   slides off the small handle mid-drag keeps being tracked.

   WHY THE GESTURE IS BOUND TO A DEDICATED HANDLE, NOT THE WHOLE SHEET:
   dragging anywhere on the sheet would fight the sheet's own scrolling
   (the drawer's tab content, the picker's model list) and would swallow taps
   on the rows inside it. The handle is an inert 22px grab strip at the top of
   the sheet with `touch-action: none` (css/chat.css `.sheet-drag-handle`),
   so there is nothing there to scroll or tap and no conflict to resolve.
   It is `display: none` on desktop for the drawer (which is a side panel, not
   a sheet, there) - that alone disables the gesture, since a display:none
   element receives no pointer events at all.

   DEGRADATION: every handler body is wrapped so a throw can never leave the
   sheet stuck under an inline transform or, worse, break the tap-to-close and
   backdrop-close paths, which stay wired independently by the call sites and
   are not touched by any of this.
   ========================================================================= */

/* Tuning. All four numbers are deliberately conservative - a bottom sheet that
   closes too eagerly is far more annoying than one that needs a slightly
   longer pull, because an accidental dismissal loses whatever the user was
   about to tap.

   DRAG_START_SLOP  6px  - below the ~8px touch slop a browser uses before it
                           calls a touch a "move", so a plain tap on the handle
                           never registers as a drag, but the sheet starts
                           following the finger essentially immediately.
   CLOSE_RATIO      0.35 - dismiss once 35% of the sheet's own height has been
                           dragged away. Height-relative, not a fixed pixel
                           count, so the 85vh drawer and the max-80vh picker
                           both need the same *proportional* effort.
   FLICK_VELOCITY   0.6 px/ms (= 600 px/s) - a deliberate downward flick
                           dismisses regardless of distance. 600 px/s is roughly
                           the low end of an intentional flick; slow settling
                           drags land well under it.
   FLICK_MIN_DIST   24px - a flick still has to have actually moved the sheet,
                           so a fast twitch on release can't dismiss from ~0px.
*/
const DRAG_START_SLOP = 6;
const CLOSE_RATIO = 0.35;
const FLICK_VELOCITY = 0.6;
const FLICK_MIN_DIST = 24;
const VELOCITY_WINDOW_MS = 100;

/* Dragging UP past the resting position is resisted rather than blocked
   outright - a hard stop feels like a bug, a small rubber band reads as
   "this only goes the other way". Capped so it can never expose the gap
   above a full-height sheet. */
const RUBBER_BAND = 0.28;
const MAX_OVERDRAG = 44;

/* Matches the sheets' own entry animation (`slideUpMobile`, 0.25s
   cubic-bezier(0.4, 0, 0.2, 1)) - the exit should not use a different
   easing language from the entry. Slightly quicker, since the user has
   already started the motion themselves. */
const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const SNAP_BACK_MS = 200;
const DISMISS_MS = 200;

function offsetFor(dy) {
  return dy >= 0 ? dy : Math.max(dy * RUBBER_BAND, -MAX_OVERDRAG);
}

/**
 * Plays a sheet's exit animation - slide the panel down off-screen, fade the
 * backdrop out - and calls `onDismiss` once it finishes. This is the ONE
 * place that animation lives: the drag-release path below delegates to it
 * (from whatever mid-drag transform is already applied), and every tap-to-
 * close path (backdrop tap, an explicit close button, a programmatic close)
 * calls it directly, so a sheet always exits the same way no matter which of
 * those triggered it - previously only a drag-release animated out; a tap on
 * the backdrop or close button just vanished instantly.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.sheetEl    - the panel to slide down.
 * @param {HTMLElement} [opts.overlayEl] - the dimmed backdrop to fade, if any.
 * @param {() => void} opts.onDismiss   - called after the animation (or
 *   immediately, if `sheetEl` is missing/invalid).
 * @returns {number|null} the settle timeout id, so a caller that might need
 *   to interrupt it (e.g. the handle being grabbed again mid-animation) can.
 */
export function dismissSheet({ sheetEl, overlayEl, onDismiss }) {
  if (!sheetEl || typeof onDismiss !== 'function') return null;
  sheetEl.style.transition = `transform ${DISMISS_MS}ms ${EASE}`;
  sheetEl.style.transform = 'translateY(100%)';
  if (overlayEl) {
    overlayEl.style.transition = `opacity ${DISMISS_MS}ms ${EASE}`;
    overlayEl.style.opacity = '0';
  }
  return window.setTimeout(() => {
    sheetEl.style.transition = '';
    sheetEl.style.transform = '';
    sheetEl.style.willChange = '';
    if (overlayEl) {
      overlayEl.style.transition = '';
      overlayEl.style.opacity = '';
    }
    try {
      onDismiss();
    } catch (err) {
      console.warn('[sheetGesture] onDismiss threw:', err);
    }
  }, DISMISS_MS);
}

/**
 * Makes `sheetEl` follow a downward drag started on `handleEl` and call
 * `onDismiss` once the drag passes the distance or velocity threshold.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.sheetEl  - the sheet panel that visually moves.
 * @param {HTMLElement} opts.handleEl - the grab strip the drag must start on.
 * @param {HTMLElement} [opts.overlayEl] - the dimmed backdrop, faded out
 *   alongside the sheet on dismiss (see `dismissSheet` above). Optional and
 *   purely cosmetic - omitting it just skips the fade.
 * @param {() => void} opts.onDismiss - closes the sheet (whatever the call
 *   site's existing close button already does). Called AFTER the slide-out
 *   animation, with the inline drag styles already cleared.
 * @returns {() => void} detach function (safe to call more than once).
 */
export function attachSheetDragToClose({ sheetEl, handleEl, overlayEl, onDismiss }) {
  if (!sheetEl || !handleEl || typeof onDismiss !== 'function') return () => {};

  let pointerId = null;
  let dragging = false;
  let startY = 0;
  let sheetHeight = 1;
  let samples = [];
  let settleTimer = null;

  const clearInlineDragStyles = () => {
    sheetEl.style.transition = '';
    sheetEl.style.transform = '';
    sheetEl.style.willChange = '';
  };

  const stopTracking = () => {
    pointerId = null;
    dragging = false;
    samples = [];
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  };

  const snapBack = () => {
    sheetEl.style.transition = `transform ${SNAP_BACK_MS}ms ${EASE}`;
    sheetEl.style.transform = 'translateY(0px)';
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      clearInlineDragStyles();
    }, SNAP_BACK_MS);
  };

  // Delegates to the shared dismissSheet() (see above) instead of duplicating
  // its animation - works correctly starting from a mid-drag transform too,
  // since it only ever transitions FROM whatever transform is already
  // applied, never resets it first.
  const dismiss = () => {
    settleTimer = dismissSheet({ sheetEl, overlayEl, onDismiss });
  };

  function onPointerDown(e) {
    try {
      if (pointerId !== null) return;                             // already tracking one
      if (!e.isPrimary) return;                                   // ignore extra fingers
      if (e.pointerType === 'mouse' && e.button !== 0) return;    // left button only

      if (settleTimer !== null) {                                 // grabbed mid-settle
        window.clearTimeout(settleTimer);
        settleTimer = null;
        clearInlineDragStyles();
      }

      pointerId = e.pointerId;
      startY = e.clientY;
      dragging = false;
      // Measured once per drag, not per move - the sheet's height cannot
      // change while it is being dragged, and getBoundingClientRect() in a
      // pointermove handler is exactly the kind of forced reflow to avoid.
      sheetHeight = sheetEl.getBoundingClientRect().height || 1;
      samples = [{ t: e.timeStamp, y: e.clientY }];

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
    } catch (err) {
      console.warn('[sheetGesture] pointerdown failed:', err);
      stopTracking();
      clearInlineDragStyles();
    }
  }

  function onPointerMove(e) {
    if (e.pointerId !== pointerId) return;
    try {
      const dy = e.clientY - startY;

      samples.push({ t: e.timeStamp, y: e.clientY });
      // Keep only the last ~100ms of movement (always at least two samples, so
      // there is something to measure even for a very short flick).
      while (samples.length > 2 && e.timeStamp - samples[0].t > VELOCITY_WINDOW_MS) samples.shift();

      if (!dragging) {
        if (Math.abs(dy) < DRAG_START_SLOP) return;
        dragging = true;
        sheetEl.style.transition = 'none';
        sheetEl.style.willChange = 'transform';
      }
      // The handle already has `touch-action: none`, so this is belt-and-braces
      // against text selection / a synthesized click on release.
      if (e.cancelable) e.preventDefault();
      sheetEl.style.transform = `translateY(${offsetFor(dy)}px)`;
    } catch (err) {
      console.warn('[sheetGesture] pointermove failed:', err);
      stopTracking();
      clearInlineDragStyles();
    }
  }

  function onPointerUp(e) {
    if (e.pointerId !== pointerId) return;
    try {
      const dy = e.clientY - startY;
      const oldest = samples[0];
      const dt = oldest ? e.timeStamp - oldest.t : 0;
      const velocity = dt > 0 ? (e.clientY - oldest.y) / dt : 0;
      const wasDragging = dragging;
      stopTracking();

      // Never moved past the slop: this was a tap on an inert strip. Leave the
      // sheet exactly as it was (and let any click proceed normally).
      if (!wasDragging) return;

      const farEnough = dy > sheetHeight * CLOSE_RATIO;
      const flicked = velocity > FLICK_VELOCITY && dy > FLICK_MIN_DIST;
      if (farEnough || flicked) dismiss();
      else snapBack();
    } catch (err) {
      console.warn('[sheetGesture] pointerup failed:', err);
      stopTracking();
      clearInlineDragStyles();
    }
  }

  function onPointerCancel(e) {
    if (e.pointerId !== pointerId) return;
    const wasDragging = dragging;
    stopTracking();
    if (wasDragging) snapBack();
  }

  const preventNativeDrag = (e) => e.preventDefault();

  handleEl.addEventListener('pointerdown', onPointerDown);
  handleEl.addEventListener('dragstart', preventNativeDrag);

  return function detach() {
    handleEl.removeEventListener('pointerdown', onPointerDown);
    handleEl.removeEventListener('dragstart', preventNativeDrag);
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
    stopTracking();
    clearInlineDragStyles();
  };
}
