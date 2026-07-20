/** Reversible mapping from pub.dev versions to xRegistry-safe Version IDs. */

const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._~:@-]{0,127}$/;
const PREFIX = 'xv~';

export function encodePubDevVersionId(version: string): string {
  const id = SAFE_ID.test(version) && !version.startsWith(PREFIX)
    ? version
    : `${PREFIX}${Buffer.from(version, 'utf8').toString('base64url')}`;
  if (!SAFE_ID.test(id)) throw new Error(`pub.dev version cannot be represented as an xRegistry ID: ${version}`);
  return id;
}

export function decodePubDevVersionId(versionId: string): string | null {
  if (!SAFE_ID.test(versionId)) return null;
  if (!versionId.startsWith(PREFIX)) return versionId;
  const encoded = versionId.slice(PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    return encodePubDevVersionId(decoded) === versionId ? decoded : null;
  } catch {
    return null;
  }
}
