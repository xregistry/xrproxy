import { decodeRepoId, encodeRepoId, isValidEncodedRepoId } from '../../src/repo-utils';

describe('repo-utils', () => {
  describe('encodeRepoId', () => {
    it('replaces slash with tilde', () => {
      expect(encodeRepoId('google/bert-base-uncased')).toBe('google~bert-base-uncased');
    });

    it('leaves plain names unchanged', () => {
      expect(encodeRepoId('gpt2')).toBe('gpt2');
    });

    it('handles org/repo with hyphens', () => {
      expect(encodeRepoId('openai-community/gpt2')).toBe('openai-community~gpt2');
    });

    it('handles names with dots and underscores', () => {
      expect(encodeRepoId('huggingface/bert.large_uncased')).toBe('huggingface~bert.large_uncased');
    });
  });

  describe('decodeRepoId', () => {
    it('replaces tilde with slash', () => {
      expect(decodeRepoId('google~bert-base-uncased')).toBe('google/bert-base-uncased');
    });

    it('leaves plain names unchanged', () => {
      expect(decodeRepoId('gpt2')).toBe('gpt2');
    });

    it('handles multiple tildes (unlikely but safe)', () => {
      expect(decodeRepoId('a~b~c')).toBe('a/b/c');
    });
  });

  describe('roundtrip', () => {
    const ids = [
      'google/bert-base-uncased',
      'gpt2',
      'openai-community/gpt2',
      'rajpurkar/squad',
      'gradio/hello_world',
      'meta-llama/Llama-3.1-8B',
    ];

    for (const id of ids) {
      it(`roundtrip: ${id}`, () => {
        expect(decodeRepoId(encodeRepoId(id))).toBe(id);
      });
    }
  });

  describe('isValidEncodedRepoId', () => {
    it('accepts plain model name', () => expect(isValidEncodedRepoId('gpt2')).toBe(true));
    it('accepts encoded owner/name', () => expect(isValidEncodedRepoId('google~bert-base-uncased')).toBe(true));
    it('accepts names with dots', () => expect(isValidEncodedRepoId('bert.large')).toBe(true));
    it('accepts names with underscores', () => expect(isValidEncodedRepoId('bert_large')).toBe(true));
    it('rejects empty string', () => expect(isValidEncodedRepoId('')).toBe(false));
    it('rejects dot', () => expect(isValidEncodedRepoId('.')).toBe(false));
    it('rejects double-dot', () => expect(isValidEncodedRepoId('..')).toBe(false));
    it('rejects path traversal', () => expect(isValidEncodedRepoId('../etc/passwd')).toBe(false));
    it('rejects slash', () => expect(isValidEncodedRepoId('google/bert')).toBe(false));
  });
});
