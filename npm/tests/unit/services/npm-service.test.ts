/**
 * Unit tests for NPM Service.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CacheManager } from '../../../src/cache/cache-manager';
import { NpmPackageManifest, NpmService } from '../../../src/services/npm-service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const createTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'npm-service-test-'));
const removeTempDir = (dirPath: string): void => {
    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
        // ignore
    }
};

const mockPackageManifest: NpmPackageManifest = {
    _id: '@scope/pkg',
    name: '@scope/pkg',
    description: 'Scoped package',
    'dist-tags': {
        latest: '1.0.0+build.1',
    },
    versions: {
        '1.0.0+build.1': {
            _id: '@scope/pkg@1.0.0+build.1',
            name: '@scope/pkg',
            version: '1.0.0+build.1',
            description: 'Scoped package',
            dependencies: {
                react: '^18.0.0',
            },
            devDependencies: {
                typescript: '^5.0.0',
            },
            peerDependencies: {
                webpack: '^5.0.0',
            },
            optionalDependencies: {
                fsevents: '^2.3.0',
            },
            bundleDependencies: ['left-pad'],
            engines: {
                node: '>=18',
            },
            os: ['linux', '!win32'],
            cpu: ['x64', '!arm'],
            keywords: ['scope', 'pkg'],
            author: 'Author Example <author@example.com> (https://author.example.com)',
            maintainers: [{ name: 'maintainer', email: 'maintainer@example.com' }],
            contributors: ['Contributor <contrib@example.com>'],
            license: 'MIT',
            repository: {
                type: 'git',
                url: 'git+https://github.com/example/repo.git',
            },
            bugs: {
                url: 'https://github.com/example/repo/issues',
            },
            homepage: 'https://example.com/pkg',
            deprecated: 'use @scope/new-pkg',
            replacedBy: '@scope/new-pkg',
            dist: {
                tarball: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz',
                shasum: 'abc123',
                integrity: 'sha512-xyz',
                fileCount: 8,
                unpackedSize: 12345,
                'npm-signature': 'signed',
            },
        },
    },
    time: {
        created: '2024-01-01T00:00:00.000Z',
        modified: '2024-01-02T00:00:00.000Z',
        '1.0.0+build.1': '2024-01-02T00:00:00.000Z',
    },
    maintainers: [{ name: 'maintainer', email: 'maintainer@example.com' }],
    author: 'Author Example <author@example.com> (https://author.example.com)',
    contributors: ['Contributor <contrib@example.com>'],
    repository: {
        type: 'git',
        url: 'git+https://github.com/example/repo.git',
    },
    homepage: 'https://example.com/pkg',
    bugs: {
        url: 'https://github.com/example/repo/issues',
    },
    license: 'MIT',
    keywords: ['scope', 'pkg'],
};


const mockSearchResults = {
    objects: [
        {
            package: {
                name: 'express',
                version: '4.18.2',
                description: 'Express framework',
                keywords: ['express', 'framework'],
                date: '2024-01-01T00:00:00.000Z',
                author: { name: 'TJ', email: 'tj@example.com' },
                maintainers: [{ username: 'tj', email: 'tj@example.com' }],
            },
            score: {
                final: 1,
                detail: { quality: 1, popularity: 1, maintenance: 1 },
            },
            searchScore: 100,
        },
    ],
    total: 1,
    time: 'now',
};

describe('NpmService', () => {
    let npmService: NpmService;
    let cacheManager: CacheManager;
    let tempDir: string;
    let mockAxiosInstance: any;

    beforeEach(() => {
        tempDir = createTempDir();
        cacheManager = new CacheManager({ baseDir: tempDir, defaultTtl: 1000, cleanupInterval: 0 });

        mockAxiosInstance = {
            get: jest.fn(),
            head: jest.fn(),
            defaults: { headers: {} },
        };

        mockedAxios.create.mockReturnValue(mockAxiosInstance);
        npmService = new NpmService({
            cacheManager,
            cacheTtl: 1000,
            knownPackageNames: ['react', 'typescript', 'webpack', 'fsevents', 'left-pad', '@scope/new-pkg', '@scope/pkg'],
        });
    });

    afterEach(() => {
        cacheManager.destroy();
        removeTempDir(tempDir);
        jest.clearAllMocks();
    });

    test('configures axios with the npm registry defaults', () => {
        expect(mockedAxios.create).toHaveBeenCalledWith({
            baseURL: 'https://registry.npmjs.org',
            timeout: 30000,
            headers: {
                'User-Agent': 'xRegistry-NPM-Wrapper/1.0',
                'Accept': 'application/json',
            },
        });
    });

    test('maps package metadata to the nodescope/package model', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: mockPackageManifest, headers: {} });

        const result = await npmService.getPackageMetadata('@scope/pkg');

        expect(result?.packageid).toBe('pkg');
        expect(result?.name).toBe('@scope/pkg');
        expect(result?.versionid).toBe('1.0.0~build.1');
        expect(result?.version).toBe('1.0.0+build.1');
        expect(result?.createdat).toBe('2024-01-01T00:00:00.000Z');
        expect(result?.modifiedat).toBe('2024-01-02T00:00:00.000Z');
        expect(result?.['dist-tags']).toEqual({ latest: '1.0.0+build.1' });
        expect(result?.dist).toEqual({
            tarball: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz',
            shasum: 'abc123',
            integrity: 'sha512-xyz',
            file_count: 8,
            unpacked_size: 12345,
            'npm-signature': 'signed',
        });
        expect(result?.author).toEqual({
            name: 'Author Example',
            email: 'author@example.com',
            url: 'https://author.example.com',
        });
        expect(result?.dependencies).toEqual([{ name: 'react', version: '^18.0.0', package: '/nodescopes/_/packages/react' }]);
        expect(result?.dev_dependencies).toEqual([{ name: 'typescript', version: '^5.0.0', package: '/nodescopes/_/packages/typescript' }]);
        expect(result?.peer_dependencies).toEqual([{ name: 'webpack', version: '^5.0.0', package: '/nodescopes/_/packages/webpack' }]);
        expect(result?.optional_dependencies).toEqual([{ name: 'fsevents', version: '^2.3.0', package: '/nodescopes/_/packages/fsevents' }]);
        expect(result?.bundle_dependencies).toEqual([{ name: 'left-pad', package: '/nodescopes/_/packages/left-pad' }]);
        expect(result?.deprecated_message).toBe('use @scope/new-pkg');
        expect(result?.deprecated).toEqual({});
        expect(result?.replacedby).toBe('/nodescopes/scope/packages/new-pkg');
    });

    test('maps version metadata using upstream publish timestamps and version ids', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: mockPackageManifest, headers: {} });

        const result = await npmService.getVersionMetadata('@scope/pkg', '1.0.0~build.1');

        expect(result?.versionid).toBe('1.0.0~build.1');
        expect(result?.version).toBe('1.0.0+build.1');
        expect(result?.packageid).toBe('pkg');
        expect(result?.createdat).toBe('2024-01-02T00:00:00.000Z');
        expect(result?.modifiedat).toBe('2024-01-02T00:00:00.000Z');
        expect(result?.dist.tarball).toContain('pkg-1.0.0.tgz');
    });

    test('caches package metadata', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: mockPackageManifest, headers: {} });

        const first = await npmService.getPackageMetadata('@scope/pkg');
        const second = await npmService.getPackageMetadata('@scope/pkg');

        expect(first).toEqual(second);
        expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    test('uses the search endpoint and maps summaries', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: mockSearchResults });

        const result = await npmService.searchPackages('express');

        expect(result?.objects[0]?.package.packageid).toBe('express');
        expect(result?.objects[0]?.package.versionid).toBe('4.18.2');
        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/-/v1/search?text=express&size=20&from=0');
    });

    test('uses canonical package names for download stats', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: { downloads: 1, start: 'x', end: 'y', package: '@scope/pkg' } });

        await npmService.getDownloadStats('@scope/pkg');

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('https://api.npmjs.org/downloads/point/last-week/@scope%2Fpkg');
    });

    test('resolves canonical package names from nodescope and packageid', async () => {
        await expect(npmService.resolveCanonicalPackageName('scope', 'pkg')).resolves.toBe('@scope/pkg');
        await expect(npmService.resolveCanonicalPackageName('_', 'react')).resolves.toBe('react');
        await expect(npmService.resolveCanonicalPackageName('scope', 'missing')).resolves.toBeNull();
    });
});
