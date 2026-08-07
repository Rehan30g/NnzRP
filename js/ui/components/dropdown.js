/* js/ui/components/dropdown.js - Custom div-based dropdown (replaces <select>)
   ============================================================================
   WHY NOT A RESTYLED <select>: native option rows can only hold flat text, so a
   proxy row could never show "name" on one line and "provider - model" dimmed
   underneath. Options here support an optional `hint` second line.

   HOW EXISTING CODE KEEPS WORKING
   -------------------------------
   Each dropdown renders a real `<input type="hidden" id="{id}">` alongside the
   visual trigger. Every pre-existing read path
   (`container.querySelector('#setting-active-proxy').value`,
   `document.getElementById('proxy-provider').value`, ...) therefore keeps
   working with zero changes. Selecting an option also dispatches a native
   `change` event on that hidden input, so a call site that assigned
   `el.onchange = fn` still fires too - the `onChange` callback passed to
   `wireDropdown` is just the more convenient path.

   PORTALLED MENU
   --------------
   The option list is appended to <body> and positioned `fixed` while open,
   never nested under the trigger. Two call sites make that mandatory:
     - modal forms: `.modal-body` is `overflow-y: auto`, which would clip an
       absolutely-positioned menu;
     - the chat composer model picker: `.chat-input-container` has
       `transform: translateX(-50%)`, which makes it a containing block for
       `position: fixed` descendants - a fixed menu inside it would be trapped
       and mispositioned.
   Only ONE menu is ever open app-wide (module-level `openState`).

   XSS: option labels/hints are user data (proxy names, model ids, persona
   names). The menu is built with `createElement` + `textContent`, never
   innerHTML, so nothing there needs escaping by callers. The serialized
   `data-options` attribute goes through `escapeAttr`.
   ============================================================================ */
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

const CHEVRON_SVG =
  '<svg class="dropdown-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="6 9 12 15 18 9"></polyline></svg>';

/** The single currently-open menu, if any. */
let openState = null;

/** Keys the open menu consumes (see `onKeyDown`); anything else passes through. */
const MENU_KEYS = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ']);

/**
 * Normalizes the loose option shapes call sites use into
 * `{ value, label, hint, disabled }`.
 * Accepts a plain string (value === label) or an object.
 */
function normalizeOptions(options) {
  return (Array.isArray(options) ? options : []).map(opt => {
    if (opt === null || opt === undefined) return null;
    if (typeof opt !== 'object') {
      return { value: String(opt), label: String(opt), hint: '', disabled: false };
    }
    return {
      value: opt.value === undefined || opt.value === null ? '' : String(opt.value),
      label: opt.label === undefined || opt.label === null ? String(opt.value ?? '') : String(opt.label),
      hint: opt.hint ? String(opt.hint) : '',
      disabled: !!opt.disabled
    };
  }).filter(Boolean);
}

function rootIdFor(id) {
  return `${id}-dropdown`;
}

function findRoot(scopeEl, id) {
  const scope = scopeEl || document;
  return scope.querySelector(`[data-dropdown-for="${CSS.escape(id)}"]`);
}

function readOptions(rootEl) {
  try {
    return normalizeOptions(JSON.parse(rootEl.dataset.options || '[]'));
  } catch {
    return [];
  }
}

function labelFor(options, value, placeholder) {
  const hit = options.find(o => o.value === value);
  if (hit) return { text: hit.label, isPlaceholder: false };
  return { text: placeholder || 'Select...', isPlaceholder: true };
}

/**
 * Builds the dropdown's HTML string.
 *
 * @param {object}   opts
 * @param {string}   opts.id            - id given to the hidden input (the value carrier)
 * @param {Array}    opts.options       - [{value,label,hint?,disabled?}] or ['a','b']
 * @param {string}   [opts.value]       - currently selected value
 * @param {string}   [opts.placeholder]
 * @param {boolean}  [opts.disabled]
 * @param {boolean}  [opts.small]       - compact trigger (chat composer / navbar)
 * @param {string}   [opts.wrapperStyle]- inline style on the `.dropdown` root
 * @param {string}   [opts.title]
 * @param {string}   [opts.ariaLabel]
 * @returns {string} HTML
 */
export function dropdownHTML({
  id,
  options = [],
  value = '',
  placeholder = 'Select...',
  disabled = false,
  small = false,
  wrapperStyle = '',
  title = '',
  ariaLabel = ''
}) {
  const opts = normalizeOptions(options);
  const current = String(value ?? '');
  const { text, isPlaceholder } = labelFor(opts, current, placeholder);
  const label = ariaLabel || title || '';

  return `
    <div class="dropdown" id="${escapeAttr(rootIdFor(id))}" data-dropdown-for="${escapeAttr(id)}"
         data-placeholder="${escapeAttr(placeholder)}"
         data-options="${escapeAttr(JSON.stringify(opts))}"
         ${wrapperStyle ? `style="${escapeAttr(wrapperStyle)}"` : ''}>
      <input type="hidden" id="${escapeAttr(id)}" value="${escapeAttr(current)}">
      <button type="button" class="dropdown-trigger${small ? ' dropdown-sm' : ''}"
              aria-haspopup="listbox" aria-expanded="false"
              ${label ? `aria-label="${escapeAttr(label)}"` : ''}
              ${title ? `title="${escapeAttr(title)}"` : ''}
              ${disabled ? 'disabled' : ''}>
        <span class="dropdown-trigger-label${isPlaceholder ? ' is-placeholder' : ''}">${escapeHtml(text)}</span>
        ${CHEVRON_SVG}
      </button>
    </div>
  `;
}

function syncTriggerLabel(rootEl) {
  const input = rootEl.querySelector('input[type="hidden"]');
  const labelEl = rootEl.querySelector('.dropdown-trigger-label');
  if (!input || !labelEl) return;
  const { text, isPlaceholder } = labelFor(readOptions(rootEl), input.value, rootEl.dataset.placeholder);
  labelEl.textContent = text;
  labelEl.classList.toggle('is-placeholder', isPlaceholder);
}

/** Positions the portalled menu under (or above) its trigger. */
function positionMenu(menuEl, triggerEl) {
  const rect = triggerEl.getBoundingClientRect();
  const gap = 4;
  menuEl.style.minWidth = `${Math.max(rect.width, 160)}px`;

  // Measure only AFTER the width is applied, so both the flip-up decision and
  // the right-edge clamp use the menu's real box (it can be wider than the
  // trigger via min-width, and shorter than its content via max-height).
  const menuWidth = menuEl.offsetWidth;
  const menuHeight = menuEl.offsetHeight;
  menuEl.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8))}px`;
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow < menuHeight + gap && rect.top > menuHeight + gap) {
    menuEl.style.top = `${rect.top - menuHeight - gap}px`;
  } else {
    menuEl.style.top = `${rect.bottom + gap}px`;
  }
}

export function closeDropdown() {
  if (!openState) return;
  const { rootEl, menuEl, triggerEl, handlers } = openState;
  document.removeEventListener('mousedown', handlers.onDocMouseDown, true);
  document.removeEventListener('keydown', handlers.onKeyDown, true);
  window.removeEventListener('resize', handlers.onReflow, true);
  window.removeEventListener('scroll', handlers.onReflow, true);
  menuEl.remove();
  rootEl.classList.remove('open');
  triggerEl.setAttribute('aria-expanded', 'false');
  openState = null;
}

function openDropdown(rootEl, onChange) {
  closeDropdown();

  const triggerEl = rootEl.querySelector('.dropdown-trigger');
  const input = rootEl.querySelector('input[type="hidden"]');
  if (!triggerEl || !input || triggerEl.disabled) return;

  const options = readOptions(rootEl);
  const menuEl = document.createElement('div');
  menuEl.className = 'dropdown-menu';
  menuEl.setAttribute('role', 'listbox');

  if (options.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dropdown-empty';
    empty.textContent = 'No options available';
    menuEl.appendChild(empty);
  }

  const optionEls = options.map(opt => {
    const el = document.createElement('div');
    el.className = 'dropdown-option';
    el.setAttribute('role', 'option');
    el.dataset.value = opt.value;
    if (opt.disabled) el.setAttribute('aria-disabled', 'true');
    if (opt.value === input.value) {
      el.classList.add('selected');
      el.setAttribute('aria-selected', 'true');
    }

    const labelEl = document.createElement('div');
    labelEl.className = 'dropdown-option-label';
    labelEl.textContent = opt.label;          // textContent => no escaping needed
    el.appendChild(labelEl);

    if (opt.hint) {
      const hintEl = document.createElement('div');
      hintEl.className = 'dropdown-option-hint';
      hintEl.textContent = opt.hint;
      el.appendChild(hintEl);
    }

    el.addEventListener('mouseenter', () => setActive(optionEls.indexOf(el)));
    el.addEventListener('click', () => {
      if (opt.disabled) return;
      commitValue(rootEl, opt.value, onChange);
      closeDropdown();
      triggerEl.focus();
    });

    menuEl.appendChild(el);
    return el;
  });

  let activeIndex = Math.max(0, options.findIndex(o => o.value === input.value));

  function setActive(idx) {
    if (idx < 0 || idx >= optionEls.length) return;
    optionEls.forEach(el => el.classList.remove('active'));
    activeIndex = idx;
    optionEls[idx].classList.add('active');
  }

  function moveActive(delta) {
    if (!optionEls.length) return;
    let next = activeIndex;
    for (let i = 0; i < optionEls.length; i++) {
      next = (next + delta + optionEls.length) % optionEls.length;
      if (!options[next].disabled) break;
    }
    setActive(next);
    optionEls[next].scrollIntoView({ block: 'nearest' });
  }

  document.body.appendChild(menuEl);
  positionMenu(menuEl, triggerEl);
  if (optionEls.length) {
    setActive(activeIndex);
    optionEls[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  const handlers = {
    onDocMouseDown: (e) => {
      if (menuEl.contains(e.target) || rootEl.contains(e.target)) return;
      closeDropdown();
    },
    onKeyDown: (e) => {
      if (!MENU_KEYS.has(e.key)) return;
      // Both preventDefault AND stopPropagation are load-bearing. This listener
      // runs in the CAPTURE phase on `document`, i.e. before the event reaches
      // the trigger button. Without stopPropagation, Enter would close the menu
      // here and then immediately hit `triggerEl.onkeydown` below, which sees
      // `openState === null` and re-opens it - the menu appeared not to close on
      // selection at all (caught in live testing, not code review). Stopping it
      // here also means Escape closes only the dropdown, not the chat drawer's
      // window-level Escape handler underneath it.
      e.preventDefault();
      e.stopPropagation();

      switch (e.key) {
        case 'Escape':
          closeDropdown();
          triggerEl.focus();
          break;
        case 'ArrowDown':
          moveActive(1);
          break;
        case 'ArrowUp':
          moveActive(-1);
          break;
        case 'Home':
          setActive(0);
          break;
        case 'End':
          setActive(optionEls.length - 1);
          break;
        case 'Enter':
        case ' ': {
          const opt = options[activeIndex];
          if (opt && !opt.disabled) {
            commitValue(rootEl, opt.value, onChange);
            closeDropdown();
            triggerEl.focus();
          }
          break;
        }
        default:
          break;
      }
    },
    // The trigger may scroll away (or be torn out by a view re-render) while
    // the menu floats over <body>; reposition, or bail out entirely.
    onReflow: () => {
      if (!triggerEl.isConnected) {
        closeDropdown();
        return;
      }
      positionMenu(menuEl, triggerEl);
    }
  };

  document.addEventListener('mousedown', handlers.onDocMouseDown, true);
  document.addEventListener('keydown', handlers.onKeyDown, true);
  window.addEventListener('resize', handlers.onReflow, true);
  window.addEventListener('scroll', handlers.onReflow, true);

  rootEl.classList.add('open');
  triggerEl.setAttribute('aria-expanded', 'true');
  openState = { rootEl, menuEl, triggerEl, handlers };
}

function commitValue(rootEl, value, onChange) {
  const input = rootEl.querySelector('input[type="hidden"]');
  if (!input) return;
  const previous = input.value;
  input.value = value;
  syncTriggerLabel(rootEl);
  if (previous === value) return;
  // Native event first, so any legacy `el.onchange = fn` wiring still fires.
  input.dispatchEvent(new Event('change', { bubbles: true }));
  if (onChange) onChange(value);
}

/**
 * Activates a dropdown previously rendered by `dropdownHTML`.
 * @param {Element|Document} scopeEl - element to search within
 * @param {string} id
 * @param {(value:string)=>void} [onChange]
 * @returns {Element|null} the `.dropdown` root
 */
export function wireDropdown(scopeEl, id, onChange) {
  const rootEl = findRoot(scopeEl, id);
  if (!rootEl) return null;
  const triggerEl = rootEl.querySelector('.dropdown-trigger');
  if (!triggerEl) return null;

  rootEl._onChange = onChange || null;

  triggerEl.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (openState && openState.rootEl === rootEl) {
      closeDropdown();
    } else {
      openDropdown(rootEl, rootEl._onChange);
    }
  };

  triggerEl.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!openState || openState.rootEl !== rootEl) openDropdown(rootEl, rootEl._onChange);
    }
  };

  syncTriggerLabel(rootEl);
  return rootEl;
}

/**
 * Replaces a live dropdown's option list (and optionally its value) in place.
 * Used by chatView's `populateModelSelect` / `populateDrawerSelects`, which
 * rebuild their choices after a proxy switch.
 */
export function setDropdownOptions(scopeEl, id, options, value) {
  const rootEl = findRoot(scopeEl, id);
  if (!rootEl) return null;
  const opts = normalizeOptions(options);
  rootEl.dataset.options = JSON.stringify(opts);

  const input = rootEl.querySelector('input[type="hidden"]');
  if (input) {
    if (value !== undefined && value !== null) {
      input.value = String(value);
    } else if (!opts.some(o => o.value === input.value)) {
      input.value = opts.length ? opts[0].value : '';
    }
  }
  syncTriggerLabel(rootEl);
  if (openState && openState.rootEl === rootEl) closeDropdown();
  return rootEl;
}

/** Sets the selected value without firing `onChange`. */
export function setDropdownValue(scopeEl, id, value) {
  const rootEl = findRoot(scopeEl, id);
  if (!rootEl) return null;
  const input = rootEl.querySelector('input[type="hidden"]');
  if (input) input.value = String(value ?? '');
  syncTriggerLabel(rootEl);
  return rootEl;
}

/** Reads the current value (equivalent to reading `#id`.value directly). */
export function getDropdownValue(scopeEl, id) {
  const rootEl = findRoot(scopeEl, id);
  const input = rootEl && rootEl.querySelector('input[type="hidden"]');
  return input ? input.value : '';
}

/** Enables/disables the trigger. */
export function setDropdownDisabled(scopeEl, id, disabled) {
  const rootEl = findRoot(scopeEl, id);
  const triggerEl = rootEl && rootEl.querySelector('.dropdown-trigger');
  if (triggerEl) triggerEl.disabled = !!disabled;
  return rootEl;
}
