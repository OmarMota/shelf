// What kind of thing is this URL? Pure functions — shared by the page and the service worker.

const EXT = {
  video: /\.(mp4|webm|mov|m4v|ogv)$/i,
  audio: /\.(mp3|wav|m4a|ogg|oga|flac|aac)$/i,
  image: /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i,
  pdf: /\.pdf$/i,
};

const X_RESERVED = new Set(['home', 'explore', 'search', 'i', 'settings', 'notifications', 'messages', 'compose', 'hashtag', 'intent', 'share']);

// -> { type, platform?, ... }
// type: file | youtube | vimeo | tweet | instagram | pinterest | video | audio | image | pdf | page
export function classify(url) {
  if ((url || '').startsWith('shelf-file:')) return { type: 'file' };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { type: 'page' };
  }
  if (!/^https?:$/.test(u.protocol)) return { type: 'page' };
  const host = u.hostname.replace(/^(www|m|mobile)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' && parts[0]) return { type: 'youtube', platform: 'youtube', id: parts[0], start: startOf(u) };
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    const id = u.searchParams.get('v') || (['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : null);
    return id ? { type: 'youtube', platform: 'youtube', id, start: startOf(u) } : { type: 'page', platform: 'youtube' };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = parts.find((p) => /^\d{6,}$/.test(p));
    return id ? { type: 'vimeo', platform: 'vimeo', id } : { type: 'page', platform: 'vimeo' };
  }
  if (host === 'x.com' || host === 'twitter.com') {
    const at = parts.indexOf('status');
    if (at > 0 && /^\d+$/.test(parts[at + 1] || '')) return { type: 'tweet', platform: 'x', id: parts[at + 1], user: parts[0] };
    const user = parts[0] && !X_RESERVED.has(parts[0]) ? parts[0] : null;
    return { type: 'page', platform: 'x', user };
  }
  if (host === 'instagram.com' || host === 'instagr.am') {
    const at = parts.findIndex((p) => ['p', 'reel', 'reels', 'tv'].includes(p));
    if (at !== -1 && parts[at + 1]) return { type: 'instagram', platform: 'instagram', code: parts[at + 1], reel: parts[at] !== 'p' };
    return { type: 'page', platform: 'instagram', user: parts[0] || null };
  }
  if (/(^|\.)pinterest\.[a-z.]+$/.test(host)) {
    const id = parts[0] === 'pin' && /(\d+)$/.exec(parts[1] || '')?.[1];
    return id ? { type: 'pinterest', platform: 'pinterest', id } : { type: 'page', platform: 'pinterest' };
  }
  for (const [type, re] of Object.entries(EXT)) if (re.test(u.pathname)) return { type };
  return { type: 'page' };
}

function startOf(u) {
  const t = u.searchParams.get('t') || u.searchParams.get('start');
  if (!t) return 0;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

export const isSocialPost = (m) => m.type === 'tweet' || m.type === 'instagram' || m.type === 'pinterest';
// Things that are, first of all, a picture: shown uncropped in the gallery view.
export const isVisual = (m) => m.type === 'instagram' || m.type === 'pinterest' || m.type === 'image';
export const isPlayable = (m) => ['youtube', 'vimeo', 'video', 'audio'].includes(m.type);
export const canSaveLocally = (m) => ['video', 'audio', 'image', 'pdf'].includes(m.type);

export const PLATFORM_FOLDER = { x: 'X (Twitter)', instagram: 'Instagram', pinterest: 'Pinterest', youtube: 'YouTube', vimeo: 'Vimeo' };

export function embedUrl(m, { dark = false } = {}) {
  switch (m.type) {
    case 'youtube':
      return `https://www.youtube.com/embed/${encodeURIComponent(m.id)}?autoplay=1&rel=0${m.start ? `&start=${m.start}` : ''}`;
    case 'vimeo':
      return `https://player.vimeo.com/video/${m.id}?autoplay=1`;
    case 'tweet':
      return `https://platform.twitter.com/embed/Tweet.html?id=${m.id}&dnt=true&theme=${dark ? 'dark' : 'light'}`;
    case 'instagram':
      return `https://www.instagram.com/${m.reel ? 'reel' : 'p'}/${encodeURIComponent(m.code)}/embed/captioned/`;
    case 'pinterest':
      return `https://assets.pinterest.com/ext/embed.html?id=${m.id}`;
    default:
      return null;
  }
}

// For files stored in My Shelf.
export function fileKind(mime = '', name = '') {
  if (mime.startsWith('video/') || EXT.video.test(name)) return 'video';
  if (mime.startsWith('audio/') || EXT.audio.test(name)) return 'audio';
  if (mime.startsWith('image/') || EXT.image.test(name)) return 'image';
  if (mime === 'application/pdf' || EXT.pdf.test(name)) return 'pdf';
  if (mime.startsWith('text/') || /\.(txt|md|json|csv|log)$/i.test(name)) return 'text';
  return 'other';
}

export function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export const extOf = (name = '') => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] || 'file').toUpperCase();
