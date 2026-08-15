// Canonical text normalization shared by the browser validator and embedding build.
// Contract: Unicode NFC -> CRLF/CR to LF -> trim -> UTF-8 SHA-256 lowercase hex.
export function normalizeText(text) {
  return String(text).normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

export async function textHash(text) {
  const bytes = new TextEncoder().encode(normalizeText(text));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
