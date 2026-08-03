/**
 * Unit tests for MCPService.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPService } from '../src/services/mcp-service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('MCPService', () => {
  let service: MCPService;
  let httpGetMock: jest.Mock;
  let cacheDir: string;

  beforeEach(() => {
    jest.clearAllMocks();

    httpGetMock = jest.fn();
    mockedAxios.create.mockReturnValue({
      get: httpGetMock,
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    } as any);

    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-service-test-'));
    service = new MCPService({
      baseUrl: 'https://test-registry.example.com',
      cacheDir,
      cacheTtl: 5000,
    });
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  describe('identity mapping', () => {
    it('derives server ids from the name portion after the single slash', () => {
      const result = service.convertToXRegistryServer({
        server: {
          name: 'github/copilot',
          version: '1.0.0',
          description: 'Copilot MCP server',
        },
      } as any, 'github', 'http://localhost:3600');

      expect(result.serverid).toBe('copilot');
      expect(result.name).toBe('github/copilot');
      expect(result.xid).toBe('/mcpproviders/github/servers/copilot');
    });

    it('hashes invalid or oversize server ids using the reserved xh~ prefix', () => {
      expect(service.deriveServerId('bad value')).toMatch(/^xh~[0-9a-f]{64}$/);
      expect(service.deriveServerId('x'.repeat(129))).toMatch(/^xh~[0-9a-f]{64}$/);
      expect(service.deriveServerId('xh~reserved')).toMatch(/^xh~[0-9a-f]{64}$/);
    });

    it('derives version ids by replacing build metadata separators with tildes', () => {
      expect(service.deriveVersionId('1.0.0+build.5')).toBe('1.0.0~build.5');
      expect(service.deriveVersionId('1.0.0')).toBe('1.0.0');
    });
  });

  describe('groupServersByProvider', () => {
    it('groups servers by their exact namespace', () => {
      const servers = [
        { server: { name: 'github/server1' } },
        { server: { name: 'github/server2' } },
        { server: { name: 'gitlab/server1' } },
      ] as any[];

      const result = service.groupServersByProvider(servers);

      expect(result.size).toBe(2);
      expect(result.get('github')?.length).toBe(2);
      expect(result.get('gitlab')?.length).toBe(1);
    });

    it('skips invalid upstream names that do not contain exactly one slash', () => {
      const servers = [
        { server: { name: 'standalone-server' } },
        { server: { name: 'too/many/slashes' } },
      ] as any[];

      const result = service.groupServersByProvider(servers);

      expect(result.size).toBe(0);
    });
  });

  describe('upstream caching and resolution', () => {
    const versionsResponse = {
      servers: [
        {
          server: {
            name: 'ac.inference.sh/mcp',
            version: '1.0.1',
            description: 'Inference server',
          },
        },
      ],
      metadata: { count: 1 },
    } as any;

    it('uses a timeout long enough for cold upstream detail requests', () => {
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 45000 })
      );
    });

    it('supports an explicit upstream timeout override', () => {
      new MCPService({
        baseUrl: 'https://test-registry.example.com',
        cacheDir,
        timeout: 60000,
      });

      expect(mockedAxios.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeout: 60000 })
      );
    });

    it('serves a fresh cached response without revalidating upstream', async () => {
      httpGetMock.mockResolvedValue({
        status: 200,
        data: versionsResponse,
        headers: { etag: '"versions-1"' },
      });

      await expect(service.getServerVersions('ac.inference.sh/mcp')).resolves.toEqual(versionsResponse);
      await expect(service.getServerVersions('ac.inference.sh/mcp')).resolves.toEqual(versionsResponse);

      expect(httpGetMock).toHaveBeenCalledTimes(1);
    });

    it('uses filesystem-safe cache filenames', async () => {
      service = new MCPService({
        baseUrl: 'http://host.docker.internal:39611',
        cacheDir,
        cacheTtl: 5000,
      });
      httpGetMock.mockResolvedValue({
        status: 200,
        data: versionsResponse,
        headers: {},
      });

      await expect(service.getAllServers()).resolves.toEqual({
        servers: versionsResponse.servers,
        metadata: {
          count: versionsResponse.servers.length,
          nextCursor: undefined,
        },
      });

      expect(fs.readdirSync(cacheDir, { withFileTypes: true }).every((entry) => entry.isFile())).toBe(true);
    });

    it('resolves a server detail directly from its xRegistry identity pair', async () => {
      const versionsSpy = jest.spyOn(service, 'getServerVersions').mockResolvedValue(versionsResponse);
      const catalogSpy = jest.spyOn(service, 'getAllServers');

      await expect(
        service.resolveServerVersions('ac.inference.sh', 'mcp')
      ).resolves.toEqual(versionsResponse);

      expect(versionsSpy).toHaveBeenCalledWith('ac.inference.sh/mcp');
      expect(catalogSpy).not.toHaveBeenCalled();
    });
  });

  describe('convertToXRegistryServer', () => {
    it('maps formal MCP attributes, publisher metadata, and registry-managed metadata', () => {
      const mcpServer = {
        server: {
          name: 'github/test-server',
          version: '1.0.0+build.5',
          description: 'Test server',
          title: 'Test Server',
          websiteUrl: 'https://example.com',
          icons: [{
            src: 'https://example.com/icon.svg',
            mimeType: 'image/svg+xml',
            sizes: ['48x48', 'any'],
            theme: 'dark',
          }],
          repository: {
            url: 'https://github.com/example/test-server',
            source: 'github',
            id: 'example/test-server',
            subfolder: 'server',
          },
          _meta: {
            'io.modelcontextprotocol.registry/publisher-provided': {
              tier: 'gold',
            },
            ignored: {
              should: 'not-appear',
            },
          },
          prompts: [{ name: 'ignore-me' }],
          tools: [{ name: 'ignore-me-too' }],
          resources: [{ name: 'still-ignored' }],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': {
            status: 'deprecated',
            statusMessage: 'Use v2',
            statusChangedAt: '2025-01-02T00:00:00Z',
            publishedAt: '2025-01-01T00:00:00Z',
            updatedAt: '2025-01-03T00:00:00Z',
            isLatest: false,
          },
        },
      } as any;

      const result = service.convertToXRegistryServer(mcpServer, 'github', 'http://localhost:3600');
      const meta = service.getServerResourceMetaAttributes(mcpServer);

      expect(result.serverid).toBe('test-server');
      expect(result.versionid).toBe('1.0.0~build.5');
      expect(result.name).toBe('github/test-server');
      expect(result.title).toBe('Test Server');
      expect(result.description).toBe('Test server');
      expect(result.website_url).toBe('https://example.com');
      expect(result.createdat).toBe('2025-01-01T00:00:00Z');
      expect(result.modifiedat).toBe('2025-01-03T00:00:00Z');
      expect(result.icons?.[0]).toEqual({
        src: 'https://example.com/icon.svg',
        mime_type: 'image/svg+xml',
        sizes: ['48x48', 'any'],
        theme: 'dark',
      });
      expect(result.repository).toEqual({
        url: 'https://github.com/example/test-server',
        source: 'github',
        id: 'example/test-server',
        subfolder: 'server',
      });
      expect(result.publisher_meta).toEqual({ tier: 'gold' });
      expect(result).not.toHaveProperty('documentation');
      expect(result).not.toHaveProperty('icon');
      expect(result).not.toHaveProperty('prompts');
      expect(result).not.toHaveProperty('tools');
      expect(result).not.toHaveProperty('resources');
      expect(meta).toEqual({
        status: 'deprecated',
        status_message: 'Use v2',
        status_changed_at: '2025-01-02T00:00:00Z',
        published_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-03T00:00:00Z',
        is_latest: false,
      });
    });

    it('maps package, input-descriptor, remote, and cross-registry xid shapes', () => {
      const mcpServer = {
        server: {
          name: 'provider/server',
          version: '2.0.0',
          description: 'Server with packages',
          packages: [
            {
              registryType: 'npm',
              identifier: '@scope/package',
              registryBaseUrl: 'https://registry.npmjs.org',
              version: '1.2.3',
              fileSha256: 'a'.repeat(64),
              runtimeHint: 'npx',
              transport: {
                type: 'streamable-http',
                url: 'https://packages.example.com/mcp',
                headers: [{ name: 'Authorization', isSecret: true, isRequired: true }],
              },
              runtimeArguments: [{ type: 'named', name: '--config', valueHint: 'config-path', isRepeated: true, format: 'filepath' }],
              packageArguments: [{ type: 'positional', valueHint: 'workspace', isRequired: true }],
              environmentVariables: [{ name: 'API_KEY', isSecret: true, format: 'string' }],
            },
            {
              registryType: 'pypi',
              identifier: 'Example_Package',
              transport: { type: 'stdio' },
            },
            {
              registryType: 'oci',
              identifier: 'library/nginx',
              registryBaseUrl: 'https://registry-1.docker.io/v2/',
              transport: { type: 'stdio' },
            },
            {
              registryType: 'nuget',
              identifier: 'Newtonsoft.Json',
              transport: { type: 'stdio' },
            },
            {
              registryType: 'mcpb',
              identifier: 'https://example.com/server.mcpb',
              transport: { type: 'stdio' },
            },
          ],
          remotes: [
            {
              type: 'streamable-http',
              url: 'https://{tenant}.example.com/mcp',
              headers: [{ name: 'Authorization', isSecret: true }],
              variables: {
                tenant: {
                  description: 'Tenant identifier',
                  isRequired: true,
                  format: 'string',
                },
              },
            },
          ],
        },
      } as any;

      const result = service.convertToXRegistryServer(mcpServer, 'provider', 'http://localhost:3600');

      expect(result.packages).toEqual([
        expect.objectContaining({
          registry_type: 'npm',
          registry_base_url: 'https://registry.npmjs.org',
          identifier: '@scope/package',
          version: '1.2.3',
          file_sha256: 'a'.repeat(64),
          runtime_hint: 'npx',
          packagexid: '/nodescopes/scope/packages/package',
          transport: {
            type: 'streamable-http',
            url: 'https://packages.example.com/mcp',
            headers: [{ name: 'Authorization', is_required: true, is_secret: true }],
          },
          runtime_arguments: [{ type: 'named', name: '--config', value_hint: 'config-path', is_repeated: true, format: 'filepath' }],
          package_arguments: [{ type: 'positional', value_hint: 'workspace', is_required: true }],
          environment_variables: [{ name: 'API_KEY', is_secret: true, format: 'string' }],
        }),
        expect.objectContaining({
          registry_type: 'pypi',
          identifier: 'Example_Package',
          packagexid: '/pythonregistries/pypi/packages/example-package',
          transport: { type: 'stdio' },
        }),
        expect.objectContaining({
          registry_type: 'oci',
          identifier: 'library/nginx',
          packagexid: '/containerregistries/docker.io/images/library~nginx',
          transport: { type: 'stdio' },
        }),
        expect.objectContaining({
          registry_type: 'nuget',
          identifier: 'Newtonsoft.Json',
          packagexid: '/dotnetregistries/nuget/packages/newtonsoft.json',
          transport: { type: 'stdio' },
        }),
        expect.objectContaining({
          registry_type: 'mcpb',
          identifier: 'https://example.com/server.mcpb',
          packagexid: 'https://example.com/server.mcpb',
          transport: { type: 'stdio' },
        }),
      ]);

      expect(result.remotes).toEqual([
        {
          type: 'streamable-http',
          url: 'https://{tenant}.example.com/mcp',
          headers: [{ name: 'Authorization', is_secret: true }],
          variables: {
            tenant: {
              description: 'Tenant identifier',
              is_required: true,
              format: 'string',
            },
          },
        },
      ]);
    });
  });
});
