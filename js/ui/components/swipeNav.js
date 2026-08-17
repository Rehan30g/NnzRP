/* js/ui/components/swipeNav.js - Swipe-left/right between the mobile bottom-
   nav tabs (Characters / Personas / Settings / MCP - the same 4 shown by the
   bottom nav; "Chat" is excluded, it's hidden from that bar entirely, see
   css/layout.css's `.sidebar-nav .nav-item[data-view="chat"] { display: none }`).

   Approach: a real live drag-follow pager (Android ViewPager / iOS
   UIPageViewController feel), NOT the earlier "swipe-commit" design. That
   first version dragged only the single #view-container element and did the
   actual navigation after the drag committed, which meant the adjacent tab
   didn't exist yet while the finger was moving - the user saw blank
   background open up beside the current tab during the drag, and then an
   empty page for the whole exit + async-render + enter window. Now:

     - As soon as the drag axis-locks horizontal, the neighbouring tab(s) are
       rendered SPECULATIVELY into their own detached-then-appended "peek"
       containers, parked exactly one container-width to the left/right of
       the current one.
     - Current + peeks are translated by the same dx every pointermove, so
       they move as one connected strip with no gap at any point.
     - On commit the already-rendered peek is ADOPTED as the new
       #view-container (see App.adoptPrerenderedView) instead of being
       re-rendered from scratch - no second IndexedDB round trip, no blank
       frame.
     - On snap-back both peeks are simply removed. None of the four swipeable
       views hold module-level state, timers, or window-level listeners (only
       chatView.js does, and chat is not in TAB_ORDER), so a plain .remove()
       is a complete teardown for them.

   Two containers must be able to co-exist because every view's render() does
   `container.innerHTML = ...` and then wires listeners by querying inside
   that one element - they cannot share a host. That is also why commit works
   by swapping element IDENTITY (the peek element itself becomes
   #view-container) rather than by moving its children into the old
   container: the views' event handlers close over the element they were
   rendered into, so that element has to survive as the live container.

   Pointer-event axis-locking (not a dedicated handle like sheetGesture.js):
   there is no natural "handle" for a whole-page tab swipe - it has to work
   from anywhere in the content area, so this defers deciding "is this a
   horizontal swipe" until the drag has moved far enough to tell, and lets
   vertical scroll (or a plain tap) proceed untouched otherwise. Mirrors
   sheetGesture.js's tap/drag disambiguation and rubber-band-at-the-limit
   feel, just walking the tab list horizontally instead of dismissing a sheet
   vertically. */

import { closeDropdown } from './dropdown.js';

export const TAB_ORDER = ['characters', 'personas', 'settings', 'mcp'];

const AXIS_LOCK_SLOP = 10;   // px of movement before deciding swipe vs scroll/tap
const AXIS_RATIO = 1.15;     // how much more horizontal than vertical movement locks it as a swipe
const CLOSE_RATIO = 0.28;    // fraction of the container's own width dragged to commit a tab change
const FLICK_VELOCITY = 0.5;  // px/ms (500 px/s) - a deliberate flick commits regardless of distance
const FLICK_MIN_DIST = 32;
const VELOCITY_WINDOW_MS = 100;

/* Rubber-band at the first/last tab (can't go further that way) - same
   resistance language as sheetGesture.js's overdrag, not a hard stop. There
   is genuinely no adjacent tab to reveal there, so no peek is created and the
   overdrag pulls against the page edge exactly like before. */
const RUBBER_BAND = 0.35;
const MAX_OVERDRAG = 60;

const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const SNAP_BACK_MS = 220;
const SETTLE_MS = 240;       // finish sliding the committed peek into place

/** Shared by attachSwipeNav's drag handling and playTabTransition below. */
function clearInlineStyles(el) {
  if (!el) return;
  el.style.transition = '';
  el.style.transform = '';
  el.style.willChange = '';
}

/**
 * Plays the swipe pager's own slide transition (current container exits,
 * pre-rendered target enters from the matching side) programmatically -
 * for a bottom-nav TAP between two swipeable tabs, not a live drag. Same
 * visual language as a swipe commit, on purpose: tapping a tab should feel
 * like the same pager the user can also drag, not a second, different
 * transition style.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.hostEl - `.app-main`.
 * @param {HTMLElement} opts.currentEl - the live #view-container being replaced.
 * @param {string} opts.targetView - route name to render into the peek.
 * @param {'left'|'right'} opts.direction - 'left' = target sorts AFTER the
 *   current tab in TAB_ORDER (current exits left, target enters from the
 *   right) - 'right' = target sorts before it (mirrored).
 * @param {(view: string, el: HTMLElement) => Promise<void>} opts.renderView
 * @returns {Promise<HTMLElement>} the settled, not-yet-adopted element - the
 *   caller (App.navigate) still owns turning it into #view-container via
 *   adoptPrerenderedView, exactly like a swipe commit does.
 */
export function playTabTransition({ hostEl, currentEl, targetView, direction, renderView }) {
  const hostRect = hostEl.getBoundingClientRect();
  const rect = currentEl.getBoundingClientRect();
  const width = rect.width || hostRect.width || 1;

  const el = document.createElement('section');
  el.className = 'view-container view-peek';
  el.setAttribute('aria-hidden', 'true');
  el.style.top = `${rect.top - hostRect.top}px`;
  el.style.left = `${rect.left - hostRect.left}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  el.style.transform = `translateX(${direction === 'left' ? width : -width}px)`;
  hostEl.appendChild(el);

  const renderPromise = Promise.resolve()
    .then(() => renderView(targetView, el))
    .catch(err => console.warn('[swipeNav] tab transition render failed:', err));

  return new Promise((resolve) => {
    // The peek was just created with its off-screen transform as an inline
    // style set moments ago - no `transition: none` needs suppressing first
    // (unlike the drag path, which reuses an already-transitioning element),
    // so a rAF tick is enough to let the browser register that starting
    // position before the transition-to-0 below is what actually animates.
    requestAnimationFrame(() => {
      const dist = direction === 'left' ? -width : width;
      currentEl.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
      currentEl.style.transform = `translateX(${dist}px)`;
      el.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
      el.style.transform = 'translateX(0px)';

      window.setTimeout(async () => {
        await renderPromise; // guards a render slower than the SETTLE_MS animation
        clearInlineStyles(currentEl);
        clearInlineStyles(el);
        resolve(el);
      }, SETTLE_MS);
    });
  });
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.hostEl - the STABLE positioned ancestor the peek
 *   containers are appended to (`.app-main`, `position: relative;
 *   overflow: hidden`). Deliberately not #view-container itself: that element
 *   is replaced wholesale on every swipe commit, so a listener bound to it
 *   would be lost after the first swipe.
 * @param {() => HTMLElement|null} opts.getContainer - resolves the CURRENT
 *   #view-container. Called lazily for the same reason.
 * @param {() => string} opts.getCurrentView - current route name. A value
 *   not present in TAB_ORDER (e.g. 'chat') just disables the gesture.
 * @param {(view: string, el: HTMLElement) => Promise<void>} opts.renderView -
 *   renders a route's view into an arbitrary element (App.renderViewInto).
 * @param {(view: string, opts: object) => Promise<void>} opts.onNavigate -
 *   the app's own navigate(); called with `{ prerenderedEl }` so it performs
 *   every routing side effect (hash, window title, sidebar/navbar re-render)
 *   but adopts the already-rendered element instead of rendering again.
 * @returns {() => void} detach function.
 */
export function attachSwipeNav({ hostEl, getContainer, getCurrentView, renderView, onNavigate }) {
  if (!hostEl
    || typeof getContainer !== 'function'
    || typeof getCurrentView !== 'function'
    || typeof renderView !== 'function'
    || typeof onNavigate !== 'function') {
    return () => {};
  }

  let pointerId = null;
  let axisLocked = null; // null = undecided, 'x' = swiping, 'y' = handed off to native scroll
  let startX = 0;
  let startY = 0;
  let containerWidth = 1;
  let samples = [];
  let settleTimer = null;
  let snapCleanup = null;    // pending post-snap-back teardown, flushable early
  let transitioning = false; // a commit animation is running - ignore new drags
  let curEl = null;          // the container being dragged (only set while axis-locked)
  const peeks = { prev: null, next: null }; // { el, view }

  const stopTracking = () => {
    pointerId = null;
    axisLocked = null;
    samples = [];
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  };

  const currentIndex = () => TAB_ORDER.indexOf(getCurrentView());

  /* --- peek containers ------------------------------------------------- */

  const destroyPeeks = (keep) => {
    for (const side of ['prev', 'next']) {
      const rec = peeks[side];
      peeks[side] = null;
      if (rec && rec.el !== keep && rec.el.parentNode) rec.el.remove();
    }
  };

  /** Creates + speculatively renders the neighbour on `side`, once per gesture. */
  const ensurePeek = (side) => {
    try {
      if (peeks[side] || !curEl) return;
      const idx = currentIndex();
      if (idx === -1) return;
      const targetIdx = side === 'next' ? idx + 1 : idx - 1;
      if (targetIdx < 0 || targetIdx >= TAB_ORDER.length) return; // boundary: nothing to show

      const view = TAB_ORDER[targetIdx];
      const hostRect = hostEl.getBoundingClientRect();
      const rect = curEl.getBoundingClientRect();

      // A `.view-container` clone parked one full width away, absolutely
      // positioned over the exact same box as the live container (explicit
      // width/height rather than inset:0, since `flex: 1` doesn't apply to an
      // absolutely positioned element). Geometry is inline; everything
      // cosmetic lives on `.view-peek` in css/layout.css.
      const el = document.createElement('section');
      el.className = 'view-container view-peek';
      el.setAttribute('aria-hidden', 'true');
      el.style.top = `${rect.top - hostRect.top}px`;
      el.style.left = `${rect.left - hostRect.left}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      el.style.transform = `translateX(${side === 'next' ? containerWidth : -containerWidth}px)`;
      hostEl.appendChild(el);

      // The drag itself must not stall on the view's IndexedDB reads, so this
      // kicks off unawaited here - but the promise is kept on the peek record
      // so goTo() can await it before adopting, in case a very fast flick
      // commits before the render actually finished (rare, but the settle
      // animation's own delay isn't a guarantee). If the gesture is abandoned
      // first, destroyPeeks() has already detached `el` and this just writes
      // into a detached node.
      const renderPromise = Promise.resolve()
        .then(() => renderView(view, el))
        .catch(err => console.warn('[swipeNav] peek render failed:', err));

      peeks[side] = { el, view, renderPromise };
    } catch (err) {
      console.warn('[swipeNav] ensurePeek failed:', err);
    }
  };

  const offsetFor = (dx, atStart, atEnd) => {
    if (dx > 0 && atStart) return Math.min(dx * RUBBER_BAND, MAX_OVERDRAG);
    if (dx < 0 && atEnd) return Math.max(dx * RUBBER_BAND, -MAX_OVERDRAG);
    return dx;
  };

  /** Moves the current container and both peeks as one connected strip. */
  const applyDrag = (offset) => {
    if (curEl) curEl.style.transform = `translateX(${offset}px)`;
    if (peeks.next) peeks.next.el.style.transform = `translateX(${containerWidth + offset}px)`;
    if (peeks.prev) peeks.prev.el.style.transform = `translateX(${-containerWidth + offset}px)`;
  };

  const setStripTransition = (value) => {
    if (curEl) curEl.style.transition = value;
    if (peeks.next) peeks.next.el.style.transition = value;
    if (peeks.prev) peeks.prev.el.style.transition = value;
  };

  /* --- settling -------------------------------------------------------- */

  /** Runs (and cancels) a pending snap-back teardown early, e.g. on re-grab. */
  const runSnapCleanup = () => {
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
    const fn = snapCleanup;
    snapCleanup = null;
    if (fn) {
      try { fn(); } catch (err) { console.warn('[swipeNav] snap cleanup failed:', err); }
    }
  };

  const snapBack = () => {
    setStripTransition(`transform ${SNAP_BACK_MS}ms ${EASE}`);
    applyDrag(0);
    const settlingEl = curEl;
    curEl = null;
    snapCleanup = () => {
      destroyPeeks(null);
      clearInlineStyles(settlingEl);
    };
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      runSnapCleanup();
    }, SNAP_BACK_MS);
  };

  // side 'next' = moving to the tab AFTER this one (current slides out left,
  // the pre-rendered next peek slides in from the right) - 'prev' mirrored.
  const goTo = (side) => {
    const rec = peeks[side];
    if (!rec) { snapBack(); return; } // nothing pre-rendered (boundary / render never started)

    transitioning = true;
    const dist = side === 'next' ? -containerWidth : containerWidth;
    setStripTransition(`transform ${SETTLE_MS}ms ${EASE}`);
    applyDrag(dist); // strip-wide: the committed peek lands on 0, the rest follow

    const oldEl = curEl;
    curEl = null;

    settleTimer = window.setTimeout(async () => {
      settleTimer = null;
      const adoptEl = rec.el;
      try {
        destroyPeeks(adoptEl); // discard the uncommitted neighbour
        // Guards the rare fast-flick case where SETTLE_MS's own delay wasn't
        // enough time for the speculative render to actually finish.
        await rec.renderPromise;
        // navigate() owns every routing side effect (hash, window title,
        // Sidebar/Navbar re-render); `prerenderedEl` only tells it to adopt
        // this element instead of rendering the view a second time.
        await onNavigate(rec.view, { prerenderedEl: adoptEl });
      } catch (err) {
        console.warn('[swipeNav] swipe navigation failed:', err);
        if (adoptEl.id !== 'view-container' && adoptEl.parentNode) adoptEl.remove();
      } finally {
        // Whichever element ended up authoritative gets its drag styles
        // cleared; if adoption failed the old one is still mounted and would
        // otherwise stay parked off-screen.
        clearInlineStyles(getContainer());
        clearInlineStyles(oldEl);
        transitioning = false;
      }
    }, SETTLE_MS);
  };

  /* --- pointer handling ------------------------------------------------ */

  function onPointerDown(e) {
    try {
      if (window.innerWidth > 768) return;   // mobile-only gesture
      if (transitioning) return;             // a commit is already animating
      if (pointerId !== null) return;
      if (!e.isPrimary) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (currentIndex() === -1) return;     // current route isn't a swipeable tab (e.g. chat)

      const container = getContainer();
      if (!container || !container.contains(e.target)) return; // header/sidebar taps aren't swipes

      runSnapCleanup(); // re-grabbing mid snap-back: finish that teardown first

      pointerId = e.pointerId;
      axisLocked = null;
      startX = e.clientX;
      startY = e.clientY;
      containerWidth = container.getBoundingClientRect().width || 1;
      samples = [{ t: e.timeStamp, x: e.clientX }];

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
    } catch (err) {
      console.warn('[swipeNav] pointerdown failed:', err);
      stopTracking();
    }
  }

  function onPointerMove(e) {
    if (e.pointerId !== pointerId) return;
    try {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      samples.push({ t: e.timeStamp, x: e.clientX });
      while (samples.length > 2 && e.timeStamp - samples[0].t > VELOCITY_WINDOW_MS) samples.shift();

      if (axisLocked === null) {
        if (Math.abs(dx) < AXIS_LOCK_SLOP && Math.abs(dy) < AXIS_LOCK_SLOP) return;
        if (Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) {
          axisLocked = 'x';
          curEl = getContainer();
          if (!curEl) { stopTracking(); return; }
          // A portalled dropdown menu lives on <body> and would stay pinned
          // to its (now sliding) trigger's old spot.
          try { closeDropdown(); } catch { /* non-fatal */ }
          curEl.style.transition = 'none';
          curEl.style.willChange = 'transform';
        } else {
          // Vertical intent - hand off to native scroll for the rest of this
          // touch rather than fighting it, same as a plain tap falling through.
          stopTracking();
          return;
        }
      }
      if (axisLocked !== 'x') return;

      if (e.cancelable) e.preventDefault();

      // Speculative render, re-checked every move: the user can reverse
      // direction mid-drag, and ensurePeek is idempotent per side, so the
      // opposite neighbour is only ever built if/when it's actually needed
      // (bounded at 2 - TAB_ORDER has at most one neighbour per side).
      ensurePeek(dx < 0 ? 'next' : 'prev');

      const idx = currentIndex();
      const atStart = idx <= 0;
      const atEnd = idx === -1 || idx >= TAB_ORDER.length - 1;
      applyDrag(offsetFor(dx, atStart, atEnd));
    } catch (err) {
      console.warn('[swipeNav] pointermove failed:', err);
      const el = curEl;
      stopTracking();
      destroyPeeks(null);
      curEl = null;
      clearInlineStyles(el);
    }
  }

  function onPointerUp(e) {
    if (e.pointerId !== pointerId) return;
    try {
      const dx = e.clientX - startX;
      const oldest = samples[0];
      const dt = oldest ? e.timeStamp - oldest.t : 0;
      const velocity = dt > 0 ? (e.clientX - oldest.x) / dt : 0;
      const wasSwiping = axisLocked === 'x';
      stopTracking();

      if (!wasSwiping) return;

      const farEnough = Math.abs(dx) > containerWidth * CLOSE_RATIO;
      const flicked = Math.abs(velocity) > FLICK_VELOCITY && Math.abs(dx) > FLICK_MIN_DIST;
      const commit = farEnough || flicked;

      // goTo() falls back to snapBack() when the peek for that side doesn't
      // exist (first/last tab, or the gesture never locked toward it).
      if (commit && dx < 0) goTo('next');
      else if (commit && dx > 0) goTo('prev');
      else snapBack();
    } catch (err) {
      console.warn('[swipeNav] pointerup failed:', err);
      const el = curEl;
      stopTracking();
      destroyPeeks(null);
      curEl = null;
      clearInlineStyles(el);
    }
  }

  function onPointerCancel(e) {
    if (e.pointerId !== pointerId) return;
    const wasSwiping = axisLocked === 'x';
    stopTracking();
    if (wasSwiping) snapBack();
  }

  const preventNativeDrag = (e) => e.preventDefault();
  hostEl.addEventListener('pointerdown', onPointerDown);
  hostEl.addEventListener('dragstart', preventNativeDrag);

  return function detach() {
    hostEl.removeEventListener('pointerdown', onPointerDown);
    hostEl.removeEventListener('dragstart', preventNativeDrag);
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
    snapCleanup = null;
    stopTracking();
    destroyPeeks(null);
    clearInlineStyles(curEl);
    clearInlineStyles(getContainer());
    curEl = null;
    transitioning = false;
  };
}
