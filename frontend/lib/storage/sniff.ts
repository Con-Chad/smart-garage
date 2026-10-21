/**
 * Identifies an upload by its leading bytes, for the MIME types we accept.
 * Browsers and apps declare `file.type` themselves, so the declared type is
 * only trusted when the content agrees with it.
 */
export function sniffMimeType(bytes: Uint8Array): string | null {
  const startsWith = (signature: number[], offset = 0) =>
    bytes.length >= offset + signature.length &&
    signature.every((byte, i) => bytes[offset + i] === byte);
  const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(ascii("GIF87a")) || startsWith(ascii("GIF89a"))) return "image/gif";
  if (startsWith(ascii("RIFF")) && startsWith(ascii("WEBP"), 8)) return "image/webp";
  // PDF readers accept a header within the first 1 KiB; real files almost
  // always start with it, but some generators prepend a BOM or whitespace.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (head.includes("%PDF-")) return "application/pdf";
  return null;
}

/** True when the bytes are what the declared MIME type claims. */
export function contentMatchesMimeType(bytes: Uint8Array, declared: string): boolean {
  return sniffMimeType(bytes) === declared;
}
