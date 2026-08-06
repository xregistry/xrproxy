/** pub.dev version IDs transliterated to xRegistry-safe IDs. */

const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._~:@-]{0,127}$/;

export function encodePubDevVersionId(version: string): string {
  if (SAFE_ID.test(version)) return version;
  const versionId = version.replace(/\+/g, '~');
  if (!SAFE_ID.test(versionId)) {
    throw new Error(`pub.dev version cannot be represented as an xRegistry ID: ${version}`);
  }
  return versionId;
}

export function decodePubDevVersionId(versionId: string): string | null {
  if (!SAFE_ID.test(versionId)) return null;
  return versionId.replace(/~/g, '+');
}
