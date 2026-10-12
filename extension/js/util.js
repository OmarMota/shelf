export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Tiny hyperscript. Bookmark data only ever goes in through text nodes / attributes, never as HTML.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'icon') el.innerHTML = ICON[v] || '';
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const svg = (body) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  // The Shelf mark: three panels receding, the same drawing as the extension icon.
  mark: '<svg viewBox="0 0 128 112" width="18" height="16" fill="currentColor" aria-hidden="true"><path d="M0 15 16 0v112L0 97ZM32 15 64 0v112L32 97ZM80 15 128 0v112L80 97Z"/></svg>',
  // Brand glyphs for the import sources, drawn to sit with the rest of the set.
  x: '<svg viewBox="-3 -3 30 30" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
  instagram: svg('<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="3.5"/><circle cx="8" cy="8" r="2.75"/><path d="M11.4 4.6h.01"/>'),
  pinterest: svg('<circle cx="8" cy="8" r="5.75"/><path d="m6.9 12.6 1.1-5.3M7.55 9.1c.25.55.75.85 1.35.85 1.15 0 2-1.05 2-2.3 0-1.25-1-2.15-2.4-2.15-1.6 0-2.75 1.1-2.75 2.5 0 .55.15 1 .45 1.35"/>'),
  review: svg('<path d="m2.25 4.5 1.4 1.4 2.35-2.9M2.25 10.75l1.4 1.4L6 9.25M8.75 4.75h5M8.75 11h5"/>'),
  search: svg('<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3.25 3.25"/>'),
  folder: svg('<path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.9c.4 0 .78.16 1.06.44l.85.87h4.69c.83 0 1.5.67 1.5 1.5v5.69c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5v-7Z"/>'),
  folderPlus: svg('<path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.9c.4 0 .78.16 1.06.44l.85.87h4.69c.83 0 1.5.67 1.5 1.5v5.69c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5v-7Z"/><path d="M8 6.75v4M6 8.75h4"/>'),
  chevron: svg('<path d="m6 3.75 4.25 4.25L6 12.25"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  edit: svg('<path d="m10.75 2.75 2.5 2.5-7.5 7.5-3 .5.5-3 7.5-7.5Z"/>'),
  trash: svg('<path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4 4.25l.6 8.1c.04.6.54 1.07 1.15 1.07h4.5c.6 0 1.1-.47 1.15-1.07l.6-8.1"/>'),
  open: svg('<path d="M5.25 3.75h7v7M12.25 3.75l-8.5 8.5"/>'),
  close: svg('<path d="m3.75 3.75 8.5 8.5M12.25 3.75l-8.5 8.5"/>'),
  camera: svg('<path d="M1.75 5.75c0-.83.67-1.5 1.5-1.5h1.5l1-1.5h4.5l1 1.5h1.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5v-5.5Z"/><circle cx="8" cy="8.5" r="2.25"/>'),
  left: svg('<path d="M10 3.75 5.75 8 10 12.25"/>'),
  right: svg('<path d="m6 3.75 4.25 4.25L6 12.25"/>'),
  back: svg('<path d="M7 3.75 2.75 8 7 12.25M2.75 8h10.5"/>'),
  link: svg('<path d="M6.75 9.25a2.5 2.5 0 0 0 3.54 0l2.25-2.25A2.5 2.5 0 0 0 9 3.46l-.75.75M9.25 6.75a2.5 2.5 0 0 0-3.54 0L3.46 9A2.5 2.5 0 0 0 7 12.54l.75-.75"/>'),
  theme: svg('<circle cx="8" cy="8" r="5.25"/><path d="M8 2.75v10.5" /><path d="M8 2.75a5.25 5.25 0 0 1 0 10.5Z" fill="currentColor" stroke="none"/>'),
  check: svg('<path d="m3.5 8.5 3 3 6-7"/>'),
  move: svg('<path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.9c.4 0 .78.16 1.06.44l.85.87h4.69c.83 0 1.5.67 1.5 1.5v5.69c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5v-7Z"/><path d="M6 9h4M8.5 7.25 10.25 9 8.5 10.75"/>'),
  grid: svg('<rect x="2.25" y="2.25" width="4.75" height="4.75" rx="1.25"/><rect x="9" y="2.25" width="4.75" height="4.75" rx="1.25"/><rect x="2.25" y="9" width="4.75" height="4.75" rx="1.25"/><rect x="9" y="9" width="4.75" height="4.75" rx="1.25"/>'),
  gallery: svg('<rect x="2.25" y="2.25" width="4.75" height="7" rx="1.25"/><rect x="9" y="2.25" width="4.75" height="4" rx="1.25"/><rect x="2.25" y="11.25" width="4.75" height="2.5" rx="1"/><rect x="9" y="8.25" width="4.75" height="5.5" rx="1.25"/>'),
  image: svg('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><circle cx="5.5" cy="6.25" r="1.1"/><path d="m2.5 12 3.6-3.6a1 1 0 0 1 1.4 0L10 10.9M9 9.9l1.4-1.4a1 1 0 0 1 1.4 0l2.2 2.2"/>'),
  copy: svg('<rect x="5.25" y="5.25" width="8" height="8" rx="1.75"/><path d="M10.75 5.25v-1c0-.83-.67-1.5-1.5-1.5h-5c-.83 0-1.5.67-1.5 1.5v5c0 .83.67 1.5 1.5 1.5h1"/>'),
  note: svg('<path d="M3.75 2.75h8.5c.55 0 1 .45 1 1v5.5l-4 4h-5.5c-.55 0-1-.45-1-1v-8.5c0-.55.45-1 1-1Z"/><path d="M13.25 9.25h-3c-.55 0-1 .45-1 1v3M5.5 6h5M5.5 8.5h2.5"/>'),
  window: svg('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="M1.75 6h12.5M4 4.4h.01M6 4.4h.01"/>'),
  heart: svg('<path d="M8 13.25s-5.25-3.1-5.25-6.9A2.85 2.85 0 0 1 8 4.8a2.85 2.85 0 0 1 5.25 1.55c0 3.8-5.25 6.9-5.25 6.9Z"/>'),
  moveOut: svg('<path d="M13.25 9.5v2.25c0 .83-.67 1.5-1.5 1.5h-7.5c-.83 0-1.5-.67-1.5-1.5V9.5M8 10.25v-7.5M5 5.5l3-3 3 3"/>'),
  play: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M5 3.2v9.6a.6.6 0 0 0 .92.5l7.3-4.8a.6.6 0 0 0 0-1L5.92 2.7A.6.6 0 0 0 5 3.2Z"/></svg>',
  gear: svg('<circle cx="8" cy="8" r="2"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.58 3.58l1.06 1.06M11.36 11.36l1.06 1.06M3.58 12.42l1.06-1.06M11.36 4.64l1.06-1.06"/>'),
  sparkle: svg('<path d="M7 2.25 8.2 5.8 11.75 7 8.2 8.2 7 11.75 5.8 8.2 2.25 7 5.8 5.8 7 2.25ZM12.25 10.25l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5Z"/>'),
  upload: svg('<path d="M8 10.25v-7.5M5 5.5l3-3 3 3M2.75 10.25v1.5c0 .83.67 1.5 1.5 1.5h7.5c.83 0 1.5-.67 1.5-1.5v-1.5"/>'),
  download: svg('<path d="M8 2.75v7.5M5 7.5l3 3 3-3M2.75 10.25v1.5c0 .83.67 1.5 1.5 1.5h7.5c.83 0 1.5-.67 1.5-1.5v-1.5"/>'),
  shelf: svg('<path d="M2 13.25h12M3.75 13.25v-8.5h2.5v8.5M6.25 13.25v-10.5h2.5v10.5M9.4 13.1 11.1 4.6l2.4.5-1.7 8.5"/>'),
  refresh: svg('<path d="M13 8a5 5 0 1 1-1.6-3.67M13.25 2.75v2.5h-2.5"/>'),
};

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

export function hueOf(str) {
  let x = 7;
  for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) >>> 0;
  return x % 360;
}

// What to call the machine Shelf runs on, in sentences like "it all stays on this Mac".
export const DEVICE = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '') ? 'Mac' : 'computer';

export const isWeb = (url) => /^https?:\/\//i.test(url || '');

export function faviconUrl(pageUrl, size = 32) {
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function plural(n, word) {
  if (n === 1) return `1 ${word}`;
  if (/[^aeiou]y$/.test(word)) return `${n} ${word.slice(0, -1)}ies`;
  return `${n} ${word}${/(s|x|ch|sh)$/.test(word) ? 'es' : 's'}`;
}

// A damped spring sampled into a CSS linear() easing, so CSS transitions and WAAPI share one feel.
export function springEasing({ stiffness = 250, damping = 25, mass = 1, duration = 0.62, samples = 36 } = {}) {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const wd = w0 * Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * duration;
    const x = 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    pts.push(i === samples ? 1 : +x.toFixed(4));
  }
  return { easing: `linear(${pts.join(',')})`, duration: duration * 1000 };
}

export const SPRING = springEasing();
export const SPRING_SOFT = springEasing({ stiffness: 170, damping: 22, duration: 0.8 });

export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
