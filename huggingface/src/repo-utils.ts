/** Hugging Face native namespace/repository identity mapping. */

export const UNNAMESPACED_GROUP_ID = '_';
export const LEGACY_HF_GROUP_ID = 'huggingface.co';

export interface HuggingFaceRepoIdentity {
  readonly groupId: string;
  readonly resourceId: string;
  readonly canonicalId: string;
}

const PART = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/;

/** Map `owner/repo` to group/resource IDs; bare repos use the reserved `_` group. */
export function repoIdToIdentity(repoId: string): HuggingFaceRepoIdentity {
  const parts = repoId.split('/');
  if (parts.length > 2 || parts.some(part => !isValidRepoPart(part))) {
    throw new Error(`Invalid Hugging Face repository ID: ${repoId}`);
  }
  if (parts.length === 1) {
    return { groupId: UNNAMESPACED_GROUP_ID, resourceId: parts[0]!, canonicalId: repoId };
  }
  if (parts[0] === UNNAMESPACED_GROUP_ID) {
    throw new Error(`Reserved Hugging Face owner namespace: ${parts[0]}`);
  }
  return { groupId: parts[0]!, resourceId: parts[1]!, canonicalId: repoId };
}

/** Reconstruct an upstream ID from slash-free xRegistry entity IDs. */
export function identityToRepoId(groupId: string, resourceId: string): string {
  if (
    !groupId || !resourceId || groupId.includes('/') || resourceId.includes('/') ||
    groupId.includes('~') || resourceId.includes('~') ||
    (groupId !== UNNAMESPACED_GROUP_ID && !isValidRepoPart(groupId)) ||
    !isValidRepoPart(resourceId)
  ) {
    throw new Error(`Invalid Hugging Face xRegistry identity: ${groupId}/${resourceId}`);
  }
  const repoId = groupId === UNNAMESPACED_GROUP_ID ? resourceId : `${groupId}/${resourceId}`;
  const roundTrip = repoIdToIdentity(repoId);
  if (roundTrip.groupId !== groupId || roundTrip.resourceId !== resourceId) {
    throw new Error(`Non-canonical Hugging Face xRegistry identity: ${groupId}/${resourceId}`);
  }
  return repoId;
}

export function isValidRepoPart(value: string): boolean {
  return Boolean(value) && value.length <= 128 && value !== '.' && value !== '..' && !value.includes('~') && PART.test(value);
}

/** Decode the removed `owner~repo` resource identity for a migration hint. */
export function decodeLegacyRepoId(value: string): HuggingFaceRepoIdentity | null {
  const parts = value.split('~');
  try {
    if (parts.length === 1) return repoIdToIdentity(value);
    if (parts.length === 2) return repoIdToIdentity(`${parts[0]}/${parts[1]}`);
  } catch {
    // Invalid legacy identity.
  }
  return null;
}
