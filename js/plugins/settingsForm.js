/* js/plugins/settingsForm.js - Declarative plugin-settings renderer
   ============================================================================
   Turns a `host.ui.registerSettings(schema)` schema into a real form inside the
   Plugins view, wired to the plugin's own `host.storage` (each field's value
   lives at key === field.key). The plugin writes ZERO DOM code.

     renderPluginSettingsForm(hostEl, schema, host)

   Field types: text | textarea | number | toggle | select.
   `schema.actions` -> buttons; `schema.custom(el, ctx)` -> an escape-hatch DOM
   slot after the sections; `schema.onChange(key, value, values)` fires after a
   field persists. All plugin callbacks are already guard()-wrapped by
   pluginHost.js.
   ============================================================================ */
import { toggleRowHTML } from '../ui/components/toggle.js';
import { dropdownHTML, wireDropdown, setDropdownValue } from '../ui/components/dropdown.js';
import { escapeHtml, escapeAttr } from '../utils/sanitize.js';

const INPUT_STYLE =
  'width:100%;box-sizing:border-box;padding:0.5rem 0.65rem;background:var(--bg-surface);' +
  'color:var(--text-main);border:1px solid var(--border-light);border-radius:var(--radius-md);font:inherit;';
const HELP_STYLE = 'font-size:0.78rem;color:var(--text-dim);line-height:1.45;margin-top:0.15rem;';
const LABEL_STYLE = 'font-size:0.85rem;font-weight:600;color:var(--text-main);';

const fieldId = (key) => 'pf-' + String(key).replace(/[^a-zA-Z0-9_-]/g, '-');

export async function renderPluginSettingsForm(hostEl, schema, host) {
  if (!hostEl) return;
  const sections = Array.isArray(schema.sections) ? schema.sections : [];
  const allFields = sections.flatMap((s) => (Array.isArray(s.fields) ? s.fields : []));

  // ---- current values: host.storage, falling back to the field default ----
  const values = {};
  for (const f of allFields) {
    let v;
    try { v = await host.storage.get(f.key); } catch { v = undefined; }
    values[f.key] = (v === undefined || v === null) ? f.default : v;
  }

  const syncControl = (key, value) => {
    const field = allFields.find((f) => f.key === key);
    if (!field) return;
    const id = fieldId(key);
    if (field.type === 'toggle') {
      const el = hostEl.querySelector('#' + CSS.escape(id));
      if (el) el.checked = !!value;
    } else if (field.type === 'select') {
      try { setDropdownValue(hostEl, id, value); } catch { /* not mounted */ }
    } else {
      const el = hostEl.querySelector('#' + CSS.escape(id));
      if (el && el.value !== String(value ?? '')) el.value = value ?? '';
    }
  };

  const ctx = {
    get values() { return { ...values }; },
    get: (key) => values[key],
    set: async (key, value) => {
      values[key] = value;
      try { await host.storage.set(key, value); } catch (e) { host.log('settings save failed', key, e); }
      if (typeof schema.onChange === 'function') schema.onChange(key, value, { ...values });
      syncControl(key, value);
    },
    refresh: () => renderPluginSettingsForm(hostEl, schema, host),
    host
  };

  // ---- build the form ----
  hostEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'plugin-scope';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:1.4rem;max-width:620px;';

  for (const section of sections) {
    const secEl = document.createElement('div');
    secEl.style.cssText = 'display:flex;flex-direction:column;gap:0.9rem;';
    if (section.title) {
      const h = document.createElement('div');
      h.textContent = section.title;
      h.style.cssText = 'font-size:0.95rem;font-weight:700;color:var(--text-main);';
      secEl.appendChild(h);
    }
    if (section.description) {
      const d = document.createElement('div');
      d.textContent = section.description;
      d.style.cssText = HELP_STYLE + 'margin-top:0;';
      secEl.appendChild(d);
    }
    for (const f of (section.fields || [])) secEl.appendChild(buildField(f, values[f.key], ctx));
    wrap.appendChild(secEl);
  }

  // ---- actions ----
  if (Array.isArray(schema.actions) && schema.actions.length) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:0.6rem;flex-wrap:wrap;align-items:center;';
    for (const a of schema.actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm ' + (a.style === 'primary' ? 'btn-primary' : a.style === 'danger' ? 'btn-danger' : 'btn-secondary');
      btn.textContent = a.label || 'Run';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await a.onClick(ctx); } finally { btn.disabled = false; }
      });
      row.appendChild(btn);
    }
    wrap.appendChild(row);
  }

  hostEl.appendChild(wrap);

  // ---- custom escape-hatch slot ----
  if (typeof schema.custom === 'function') {
    const slot = document.createElement('div');
    slot.className = 'plugin-scope';
    slot.style.cssText = 'margin-top:1.4rem;';
    hostEl.appendChild(slot);
    try { schema.custom(slot, ctx); } catch (e) { host.log('settings custom slot failed', e); }
  }

  // Selects need wiring after they're in the DOM.
  for (const f of allFields) {
    if (f.type !== 'select') continue;
    wireDropdown(hostEl, fieldId(f.key), (val) => ctx.set(f.key, val));
  }
}

function buildField(f, value, ctx) {
  const id = fieldId(f.key);

  if (f.type === 'toggle') {
    const holder = document.createElement('div');
    holder.innerHTML = toggleRowHTML({
      id,
      checked: !!value,
      title: escapeHtml(f.label || f.key),
      description: f.help ? escapeHtml(f.help) : ''
    });
    const cb = holder.querySelector('#' + CSS.escape(id));
    if (cb) cb.addEventListener('change', () => ctx.set(f.key, cb.checked));
    return holder.firstElementChild || holder;
  }

  const block = document.createElement('div');
  block.style.cssText = 'display:flex;flex-direction:column;gap:0.3rem;';
  const label = document.createElement('label');
  label.setAttribute('for', id);
  label.textContent = f.label || f.key;
  label.style.cssText = LABEL_STYLE;
  block.appendChild(label);

  if (f.type === 'select') {
    const opts = (Array.isArray(f.options) ? f.options : []).map((o) => ({
      value: String(o.value), label: String(o.label ?? o.value)
    }));
    const dd = document.createElement('div');
    dd.innerHTML = dropdownHTML({ id, options: opts, value: String(value ?? '') });
    block.appendChild(dd.firstElementChild || dd);
    // change is wired via wireDropdown() after mount (see caller).
  } else if (f.type === 'textarea') {
    const ta = document.createElement('textarea');
    ta.id = id;
    ta.rows = Number(f.rows) || 3;
    ta.placeholder = f.placeholder || '';
    ta.value = value ?? '';
    ta.style.cssText = INPUT_STYLE + 'resize:vertical;';
    ta.addEventListener('change', () => ctx.set(f.key, ta.value));
    block.appendChild(ta);
  } else {
    const input = document.createElement('input');
    input.id = id;
    input.type = f.type === 'number' ? 'number' : 'text';
    if (f.type === 'number') {
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      if (f.step != null) input.step = f.step;
    }
    input.placeholder = f.placeholder || '';
    input.spellcheck = false;
    input.value = value ?? '';
    input.style.cssText = INPUT_STYLE;
    input.addEventListener('change', () => {
      ctx.set(f.key, f.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value);
    });
    block.appendChild(input);
  }

  if (f.help) {
    const help = document.createElement('div');
    help.textContent = f.help;
    help.style.cssText = HELP_STYLE;
    block.appendChild(help);
  }
  return block;
}
