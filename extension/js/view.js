// Opens one file from My Shelf in its own tab: view.html#<blobId>?name=…&mime=…

import { local } from './local.js';
import { fileKind } from './media.js';

const [blobId, query = ''] = location.hash.slice(1).split('?');
const params = new URLSearchParams(query);
const name = params.get('name') || 'File';
const mime = params.get('mime') || '';
document.title = name;

const el = (tag, props) => Object.assign(document.createElement(tag), props);

const blob = await local.getBlob(blobId).catch(() => null);
if (!blob) {
  document.body.append(el('p', { textContent: 'This file is no longer in My Shelf.' }));
} else {
  const src = URL.createObjectURL(blob);
  const kind = fileKind(mime || blob.type, name);
  if (kind === 'video' || kind === 'audio') document.body.append(el(kind, { src, controls: true, autoplay: true }));
  else if (kind === 'image') document.body.append(el('img', { src, alt: name }));
  else if (kind === 'pdf') document.body.append(el('iframe', { src, title: name }));
  else if (kind === 'text') document.body.append(el('pre', { textContent: await blob.text() }));
  else document.body.append(el('a', { href: src, download: name, textContent: `Download ${name}` }));
}
