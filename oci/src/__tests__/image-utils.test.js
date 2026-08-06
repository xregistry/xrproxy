const { matchesImageId, repositoryNameFromImageId, toImageId } = require('../../dist/oci/src/utils/image-utils.js');

describe('image id mapping', () => {
  test('maps slash-separated repositories to tilde-separated image ids', () => {
    expect(toImageId('library/nginx')).toBe('library~nginx');
    expect(repositoryNameFromImageId('library~nginx')).toBe('library/nginx');
    expect(matchesImageId('library/nginx', 'library~nginx')).toBe(true);
  });

  test('hashes image ids longer than 128 characters with the reserved xh~ prefix', () => {
    const repository = `org/${'a'.repeat(140)}`;
    const imageId = toImageId(repository);

    expect(imageId.startsWith('xh~')).toBe(true);
    expect(imageId).toHaveLength(67);
    expect(repositoryNameFromImageId(imageId)).toBeUndefined();
  });
});
