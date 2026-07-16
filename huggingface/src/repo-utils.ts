/** Encodes a Hugging Face repo ID for use as a single URL path segment.
 *
 * HF repo IDs have the form `{owner}/{name}` (e.g. `google/bert-base-uncased`).
 * A bare `/` is a reserved path separator in URLs so we map it to `~`.
 * Tilde is unreserved in URIs (RFC 3986 §2.3) and never used in HF repo names.
 *
 * Examples:
 *   `google/bert-base-uncased` → `google~bert-base-uncased`
 *   `gpt2`                     → `gpt2`
 */
export function encodeRepoId(repoId: string): string {
  return repoId.replace(/\//g, '~');
}

/** Decodes a URL path segment back to a Hugging Face repo ID. */
export function decodeRepoId(segment: string): string {
  return segment.replace(/~/g, '/');
}

/** Returns true if the segment is a syntactically valid encoded repo ID.
 *  Repo IDs may contain letters, digits, hyphens, underscores, dots and exactly
 *  one optional `~` (which represents the owner/name separator).
 */
export function isValidEncodedRepoId(segment: string): boolean {
  // Reject empty or path-traversal-like segments
  if (!segment || segment === '.' || segment === '..') return false;
  // Allow alphanumeric, hyphens, underscores, dots, tildes (for the slash)
  return /^[A-Za-z0-9._~-]+$/.test(segment) && !segment.startsWith('.') && !segment.endsWith('.');
}
