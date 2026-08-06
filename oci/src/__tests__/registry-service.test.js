const { EntityStateManager } = require('../../dist/shared/entity-state-manager.js');
const { RegistryService } = require('../../dist/oci/src/services/registry-service.js');

describe('RegistryService OCI projection', () => {
  function createResponse() {
    return {
      headersSent: false,
      statusCode: 200,
      set: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      status: jest.fn().mockImplementation(function (code) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn().mockImplementation(function (body) {
        this.body = body;
        return this;
      }),
    };
  }

  function createRequest(overrides = {}) {
    return {
      protocol: 'https',
      get: (header) => header.toLowerCase() === 'host' ? 'example.test' : undefined,
      query: {},
      params: {},
      path: '/',
      originalUrl: '/',
      ...overrides,
    };
  }

  const image = {
    imageid: 'library~nginx',
    versionid: 'latest',
    isdefault: true,
    name: 'library/nginx',
    versionsurl: 'https://example.test/containerregistries/docker.io/images/library~nginx/versions',
    versionscount: 1,
    metaurl: 'https://example.test/containerregistries/docker.io/images/library~nginx/meta',
    xid: '/containerregistries/docker.io/images/library~nginx',
    self: 'https://example.test/containerregistries/docker.io/images/library~nginx',
    epoch: 1,
    createdat: '2026-01-01T00:00:00.000Z',
    modifiedat: '2026-01-01T00:00:00.000Z',
    metadata: {
      digest: 'sha256:abc',
      manifest_mediatype: 'application/vnd.oci.image.manifest.v1+json',
    },
  };

  const meta = {
    xid: '/containerregistries/docker.io/images/library~nginx/meta',
    self: 'https://example.test/containerregistries/docker.io/images/library~nginx/meta',
    epoch: 1,
    createdat: '2026-01-01T00:00:00.000Z',
    modifiedat: '2026-01-01T00:00:00.000Z',
    readonly: true,
    defaultversionid: 'latest',
    defaultversionurl: 'https://example.test/containerregistries/docker.io/images/library~nginx/versions/latest',
    defaultversionsticky: true,
    sourceurl: 'https://registry-1.docker.io/v2/',
    namespace: 'library',
    repository: 'library/nginx',
  };

  const version = {
    versionid: 'latest',
    isdefault: true,
    name: 'latest',
    xid: '/containerregistries/docker.io/images/library~nginx/versions/latest',
    self: 'https://example.test/containerregistries/docker.io/images/library~nginx/versions/latest',
    epoch: 1,
    createdat: '2026-01-01T00:00:00.000Z',
    modifiedat: '2026-01-01T00:00:00.000Z',
    metadata: {
      digest: 'sha256:abc',
    },
  };

  const imageService = {
    getBackends: jest.fn().mockReturnValue([{ id: 'docker.io', name: 'Docker Hub', url: 'https://registry-1.docker.io', enabled: true }]),
    getBackend: jest.fn().mockReturnValue({ id: 'docker.io', name: 'Docker Hub', url: 'https://registry-1.docker.io', enabled: true }),
    getTotalImageCount: jest.fn().mockResolvedValue(1),
    getAllImages: jest.fn().mockResolvedValue({ images: [image], totalCount: 1 }),
    getImage: jest.fn().mockResolvedValue({ ...image }),
    getImageMeta: jest.fn().mockResolvedValue(meta),
    getImageVersions: jest.fn().mockResolvedValue({ versions: [version], totalCount: 1 }),
    getImageVersion: jest.fn().mockResolvedValue(version),
  };

  const service = new RegistryService({ imageService }, new EntityStateManager());

  test('returns groups keyed by canonical containerregistryid with sourceurl', async () => {
    const response = createResponse();
    await service.getGroups(createRequest({ path: '/containerregistries', originalUrl: '/containerregistries' }), response);

    expect(response.body).toEqual({
      'docker.io': expect.objectContaining({
        containerregistryid: 'docker.io',
        sourceurl: 'https://registry-1.docker.io/v2/',
        imagescount: 1,
      }),
    });
  });

  test('keeps repository-scope attributes under meta and keys collections by imageid/versionid', async () => {
    const response = createResponse();
    await service.getResource(createRequest({
      path: '/containerregistries/docker.io/images/library~nginx',
      originalUrl: '/containerregistries/docker.io/images/library~nginx?inline=meta,versions',
      params: { groupId: 'docker.io', resourceId: 'library~nginx' },
      xregistryFlags: { inline: ['meta', 'versions'] },
    }), response);

    expect(response.body.imageid).toBe('library~nginx');
    expect(response.body.namespace).toBeUndefined();
    expect(response.body.meta).toEqual(expect.objectContaining({
      namespace: 'library',
      repository: 'library/nginx',
      defaultversionsticky: true,
    }));
    expect(response.body.versions).toEqual({ latest: version });
  });
});
