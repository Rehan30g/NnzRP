/* js/utils/imageUtils.js - Shared helpers for image attachments (chat uploads
 * and the builtin fetch-image tool both funnel through these). */

// base64 data: URLs run ~33% bigger than the source bytes - same generous cap
// as avatarPicker.js uses for the same reason.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;

/** Reads a File/Blob into a base64 `data:` URL. */
export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Splits a `data:<mime>;base64,<data>` URL into its parts. Returns null for
 * anything that isn't a base64 data URL (e.g. a plain http(s) URL slipped in
 * some other way) - callers must skip those rather than send garbage to a
 * provider's image API.
 */
export function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}
