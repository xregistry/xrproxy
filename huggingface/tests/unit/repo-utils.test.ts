import {
  decodeLegacyRepoId,
  identityToRepoId,
  repoIdToIdentity,
  UNNAMESPACED_GROUP_ID,
} from '../../src/repo-utils';

describe('Hugging Face xRegistry repository identity', () => {
  it('maps owner to group and basename to resource', () => {
    expect(repoIdToIdentity('google-bert/bert-base-uncased')).toEqual({
      groupId: 'google-bert', resourceId: 'bert-base-uncased', canonicalId: 'google-bert/bert-base-uncased',
    });
  });

  it('uses the valid reserved _ group for an unnamespaced repository', () => {
    expect(repoIdToIdentity('gpt2')).toEqual({
      groupId: UNNAMESPACED_GROUP_ID, resourceId: 'gpt2', canonicalId: 'gpt2',
    });
    expect(identityToRepoId('_', 'gpt2')).toBe('gpt2');
    expect(() => identityToRepoId('@', 'gpt2')).toThrow();
    expect(() => repoIdToIdentity('_/repo')).toThrow();
  });

  it('round-trips canonical owner/repository IDs', () => {
    const identity = repoIdToIdentity('meta-llama/Llama-3.1-8B');
    expect(identityToRepoId(identity.groupId, identity.resourceId)).toBe('meta-llama/Llama-3.1-8B');
  });

  it('rejects slash-bearing group and resource entity IDs', () => {
    expect(() => identityToRepoId('google/models', 'bert')).toThrow();
    expect(() => identityToRepoId('google', 'bert/base')).toThrow();
  });

  it('rejects repository IDs with more than one slash', () => {
    expect(() => repoIdToIdentity('owner/nested/repo')).toThrow();
    expect(() => repoIdToIdentity(`owner/${'x'.repeat(129)}`)).toThrow();
  });

  it('decodes removed owner~repo IDs only for migration hints', () => {
    expect(decodeLegacyRepoId('google-bert~bert-base-uncased')).toMatchObject({
      groupId: 'google-bert', resourceId: 'bert-base-uncased',
    });
  });
});
