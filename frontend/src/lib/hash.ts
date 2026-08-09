/**
 * id = sha1(lang + "\0" + text). Used to dedupe candidates within a session
 * and never resend a hash the backend has already resolved.
 * See docs/ARCHITECTURE.md section 4.1, "Hash and dedupe".
 */
export async function snippetId(lang: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(`${lang}\u0000${text}`);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
