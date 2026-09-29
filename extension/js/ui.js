// Small floating UI: toasts, context menus, and dialogs.

import { $, h, clamp } from './util.js';

const layer = () => $('#layer');

// ---------- toast ----------

let toastEl = null;
let toastTimer = 0;

export function toast(message, { action, onAction, ms = 5200 } = {}) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  const el = (toastEl = h(
    'div',
    { class: 'toast', role: 'status' },
    h('span', {}, message),
    action &&
      h('button', { class: 'toast-act', onclick: () => (dismiss(), onAction?.()) }, action),
  ));
  const dismiss = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
    if (toastEl === el) toastEl = null;
  };
  layer().append(el);
  toastTimer = setTimeout(dismiss, ms);
  return dismiss;
}

// ---------- context menu ----------

let menuEl = null;

export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

// items: [{ label, icon, danger, hint, run }] with null as a separator
export function openMenu(x, y, items) {
  closeMenu();
  const el = (menuEl = h('div', { class: 'menu', role: 'menu' }));
  for (const it of items) {
    if (!it) {
      el.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    el.append(
      h(
        'button',
        {
          class: 'menu-item' + (it.danger ? ' danger' : ''),
          role: 'menuitem',
          onclick: () => (closeMenu(), it.run()),
        },
        h('span', { class: 'menu-ico', icon: it.icon }),
        h('span', { class: 'menu-label' }, it.label),
        it.hint && h('kbd', {}, it.hint),
      ),
    );
  }
  layer().append(el);
  // offsetWidth, not getBoundingClientRect: the menu is mid scale-in animation right now.
  el.style.left = clamp(x, 8, innerWidth - el.offsetWidth - 8) + 'px';
  el.style.top = clamp(y, 8, innerHeight - el.offsetHeight - 8) + 'px';
  el.querySelector('button')?.focus({ preventScroll: true });
}

addEventListener('pointerdown', (e) => menuEl && !menuEl.contains(e.target) && closeMenu(), true);
addEventListener('blur', closeMenu);
addEventListener('resize', closeMenu);
addEventListener(
  'keydown',
  (e) => {
    if (!menuEl) return;
    const items = [...menuEl.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

// ---------- dialogs ----------

export const dialogOpen = () => !!$('.dialog-wrap');

export function openDialog(content, { onClose, wide = false } = {}) {
  const wrap = h('div', { class: 'dialog-wrap' }, h('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' }, content));
  const close = () => {
    wrap.classList.add('out');
    setTimeout(() => wrap.remove(), 180);
    removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key !== 'Enter' && e.key !== 'Tab') {
      e.stopPropagation(); // typing in a dialog must not trigger canvas shortcuts
    }
  };
  addEventListener('keydown', onKey, true);
  wrap.addEventListener('pointerdown', (e) => e.target === wrap && close());
  layer().append(wrap);
  return close;
}

// fields: [{ name, label, value, placeholder, type }]; type 'textarea' gives a few lines (⌘↩ saves)
export function formDialog({ title, fields, submit = 'Save', focus = null }) {
  return new Promise((resolve) => {
    let result = null;
    const inputs = {};
    const form = h(
      'form',
      {
        class: 'form',
        onsubmit: (e) => {
          e.preventDefault();
          result = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
          close();
        },
      },
      h('h2', {}, title),
      fields.map((f) =>
        h(
          'label',
          { class: 'field' },
          h('span', {}, f.label),
          (inputs[f.name] =
            f.type === 'textarea'
              ? h(
                  'textarea',
                  {
                    rows: '3',
                    placeholder: f.placeholder || '',
                    onkeydown: (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && form.requestSubmit(),
                  },
                  f.value || '',
                )
              : h('input', {
                  type: f.type || 'text',
                  value: f.value || '',
                  placeholder: f.placeholder || '',
                  spellcheck: 'false',
                  autocomplete: 'off',
                  required: f.required,
                })),
        ),
      ),
      h(
        'div',
        { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, submit),
      ),
    );
    const close = openDialog(form, { onClose: () => resolve(result) });
    const first = inputs[focus] || Object.values(inputs)[0];
    first?.focus();
    if (first?.tagName === 'INPUT') first.select();
    else first?.setSelectionRange(first.value.length, first.value.length);
  });
}

// folders: [{ id, title, depth, disabled }]
export function folderPicker({ title, folders, currentId }) {
  return new Promise((resolve) => {
    let result = null;
    const list = h('div', { class: 'picker-list' });
    const draw = (q = '') => {
      list.replaceChildren(
        ...folders
          .filter((f) => !q || f.title.toLowerCase().includes(q))
          .map((f) =>
            h(
              'button',
              {
                type: 'button',
                class: 'picker-row' + (f.id === currentId ? ' current' : ''),
                disabled: f.disabled,
                style: { paddingLeft: 10 + (q ? 0 : f.depth * 16) + 'px' },
                onclick: () => ((result = f.id), close()),
              },
              h('span', { class: 'menu-ico', icon: 'folder' }),
              h('span', {}, f.title),
            ),
          ),
      );
    };
    const input = h('input', {
      type: 'text',
      placeholder: 'Filter folders…',
      spellcheck: 'false',
      oninput: () => draw(input.value.trim().toLowerCase()),
    });
    draw();
    const close = openDialog(h('div', { class: 'form picker' }, h('h2', {}, title), input, list), {
      onClose: () => resolve(result),
    });
    input.focus();
  });
}
