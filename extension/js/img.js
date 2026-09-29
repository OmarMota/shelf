// Image helpers that work in both the page and the service worker.

export async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

// Downscale (and optionally crop) to a JPEG blob.
export async function toJpeg(source, { maxW = 960, crop = null, quality = 0.84 } = {}) {
  const bmp = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  const c = crop
    ? {
        x: Math.max(0, Math.round(crop.x)),
        y: Math.max(0, Math.round(crop.y)),
        w: Math.round(crop.w),
        h: Math.round(crop.h),
      }
    : { x: 0, y: 0, w: bmp.width, h: bmp.height };
  c.w = Math.min(c.w, bmp.width - c.x);
  c.h = Math.min(c.h, bmp.height - c.y);
  const scale = Math.min(1, maxW / c.w);
  const w = Math.max(1, Math.round(c.w * scale));
  const h = Math.max(1, Math.round(c.h * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { blob, width: w, height: h, srcWidth: bmp.width, srcHeight: bmp.height };
}
