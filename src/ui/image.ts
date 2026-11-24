import { NOTE_IMAGE_MAX_EDGE } from '../core/protocol.ts';

/**
 * 截圖原檔常常 3–5 MB（4K 螢幕的 PNG）。先在瀏覽器縮到長邊 1568px、轉成 JPEG：
 * 一張約 200–400 KB，上傳快，送進 LLM 也不會被它自己再縮一次。
 * 透明背景先鋪白，不然轉 JPEG 會變黑底。
 */
export async function shrinkImage(file: Blob, maxEdge = NOTE_IMAGE_MAX_EDGE): Promise<{ mime: string; base64: string }> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('瀏覽器不支援 canvas，沒辦法處理圖片');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob) throw new Error('圖片轉檔失敗');
    return { mime: 'image/jpeg', base64: await toBase64(blob) };
  } finally {
    bitmap.close();
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('讀取圖片失敗'));
    reader.readAsDataURL(blob);
  });
}
