import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import modelData from '../../model.json';
import { EntityStateManager } from '../../../shared/entity-state-manager';
import { PackageService } from '../../src/services/package-service';
import type { PubDevService } from '../../src/services/pubdev-service';

const repositoryRoot = path.basename(process.cwd()).toLowerCase() === 'pubdev'
  ? path.resolve(process.cwd(), '..')
  : process.cwd();
const {
  assertMetaConforms,  assertVersionConforms,
} = require(path.join(repositoryRoot, 'test/helpers/xregistry-model-conformance.cjs'));

function makeService(overrides: Partial<PubDevService>): PackageService {
  const upstream = {
    fetchPackage: async () => null,
    fetchScore: async () => null,
    fetchPublisher: async () => null,
    getUpstreamBase: () => 'https://pub.dev',
    ...overrides,
  } as unknown as PubDevService;
  return new PackageService(upstream, new EntityStateManager());
}

test('PackageService maps spec-defined attributes to version and meta locations', async () => {
  const pkg = {
    name: 'example',
    latest: {
      version: '1.5.0',
      pubspec: {
        name: 'example',
        version: '1.5.0',
        description: 'Example package',
        homepage: 'https://example.dev',
        repository: { url: 'https://github.com/example/example' },
        issue_tracker: 'https://github.com/example/example/issues',
        documentation: 'https://docs.example.dev',
        topics: ['cli', 'tooling'],
        environment: {
          sdk: '>=3.0.0 <4.0.0',
          flutter: '>=3.22.0',
          customsdk: '^1.0.0',
        },
        platforms: {
          android: {},
          web: {},
        },
        dependencies: {
          http: '^1.2.0',
          flutter: { sdk: 'flutter' },
          git_dep: { git: { url: 'https://github.com/example/git_dep.git', ref: 'main', path: 'pkg' } },
          path_dep: { path: '../path_dep' },
          foreign_dep: { hosted: { url: 'https://private.example.dev', name: 'foreign_real' }, version: '^2.0.0' },
          renamed_dep: { hosted: { name: 'actual_dep' }, version: '^3.0.0' },
        },
        dev_dependencies: {
          test: '^1.25.0',
        },
        dependency_overrides: {
          collection: { version: '^1.18.0' },
        },
      },
      archive_url: 'https://pub.dev/packages/example/versions/1.5.0.tar.gz',
      archive_sha256: 'sha-example',
      published: '2024-02-01T00:00:00.000Z',
      retracted: false,
    },
    versions: [
      {
        version: '1.5.0',
        pubspec: {
          name: 'example',
          version: '1.5.0',
          description: 'Example package',
          homepage: 'https://example.dev',
          repository: { url: 'https://github.com/example/example' },
          issue_tracker: 'https://github.com/example/example/issues',
          documentation: 'https://docs.example.dev',
          topics: ['cli', 'tooling'],
          environment: {
            sdk: '>=3.0.0 <4.0.0',
            flutter: '>=3.22.0',
            customsdk: '^1.0.0',
          },
          platforms: {
            android: {},
            web: {},
          },
          dependencies: {
            http: '^1.2.0',
            flutter: { sdk: 'flutter' },
            git_dep: { git: { url: 'https://github.com/example/git_dep.git', ref: 'main', path: 'pkg' } },
            path_dep: { path: '../path_dep' },
            foreign_dep: { hosted: { url: 'https://private.example.dev', name: 'foreign_real' }, version: '^2.0.0' },
            renamed_dep: { hosted: { name: 'actual_dep' }, version: '^3.0.0' },
          },
          dev_dependencies: {
            test: '^1.25.0',
          },
          dependency_overrides: {
            collection: { version: '^1.18.0' },
          },
        },
        archive_url: 'https://pub.dev/packages/example/versions/1.5.0.tar.gz',
        archive_sha256: 'sha-example',
        published: '2024-02-01T00:00:00.000Z',
        retracted: false,
      },
    ],
    isDiscontinued: true,
    replacedBy: 'example_next',
    advisoriesUpdated: '2024-02-15T00:00:00.000Z',
  };
  const service = makeService({
    fetchPackage: async () => pkg,
    fetchScore: async () => ({
      likeCount: 12,
      grantedPoints: 140,
      maxPoints: 160,
      downloadCount30Days: 3456,
      tags: ['license:MIT', 'license:Apache-2.0', 'platform:android', 'platform:web', 'sdk:dart'],
    }),
    fetchPublisher: async () => ({ publisherId: 'dart.dev' }),
  });

  const resource = await service.getPackageMetadata('example', 'https://registry.example.test');  assert.equal(resource['homepage'], 'https://example.dev');
  assert.equal(resource['repository'], 'https://github.com/example/example');
  assert.equal(resource['issue_tracker'], 'https://github.com/example/example/issues');
  assert.equal(resource['documentation'], 'https://docs.example.dev');
  assert.deepEqual(resource['topics'], ['cli', 'tooling']);
  assert.deepEqual(resource['environment'], {
    sdk: '>=3.0.0 <4.0.0',
    flutter: '>=3.22.0',
    customsdk: '^1.0.0',
  });
  assert.equal(resource['sdk_constraint'], '>=3.0.0 <4.0.0');
  assert.equal(resource['flutter_constraint'], '>=3.22.0');
  assert.deepEqual(resource['declared_platforms'], { android: {}, web: {} });
  assert.equal(Object.hasOwn(resource, 'keywords'), false);
  assert.equal(Object.hasOwn(resource, 'platforms'), false);
  assert.equal(Object.hasOwn(resource, 'license'), false);
  assert.deepEqual(resource['dependencies'], {
    http: { source: 'hosted', constraint: '^1.2.0', package: '/dartregistries/pub/packages/http' },
    flutter: { source: 'sdk', sdk: 'flutter' },
    git_dep: { source: 'git', git_url: 'https://github.com/example/git_dep.git', git_ref: 'main', git_path: 'pkg' },
    path_dep: { source: 'path', path: '../path_dep' },
    foreign_dep: { source: 'hosted', constraint: '^2.0.0', hosted_url: 'https://private.example.dev', hosted_name: 'foreign_real' },
    renamed_dep: { source: 'hosted', constraint: '^3.0.0', hosted_name: 'actual_dep', package: '/dartregistries/pub/packages/actual_dep' },
  });
  assert.deepEqual(resource['dev_dependencies'], {
    test: { source: 'hosted', constraint: '^1.25.0', package: '/dartregistries/pub/packages/test' },
  });
  assert.deepEqual(resource['dependency_overrides'], {
    collection: { source: 'hosted', constraint: '^1.18.0', package: '/dartregistries/pub/packages/collection' },
  });

  const meta = await service.getPackageMeta('example', 'https://registry.example.test');
  assertMetaConforms(modelData, 'dartregistries', 'packages', meta, 'pubdev.mapped-meta');
  assert.equal(meta['is_discontinued'], true);
  assert.equal(meta['replaced_by'], 'example_next');
  assert.equal(meta['advisories_updated'], '2024-02-15T00:00:00.000Z');
  assert.equal(meta['publisher'], 'dart.dev');
  assert.equal(meta['likes'], 12);
  assert.equal(meta['pub_points'], 140);
  assert.equal(meta['max_points'], 160);
  assert.equal(meta['download_count_30_days'], 3456);
  assert.deepEqual(meta['tags'], ['license:MIT', 'license:Apache-2.0', 'platform:android', 'platform:web', 'sdk:dart']);
  assert.deepEqual(meta['license'], ['mit', 'apache-2.0']);
  assert.deepEqual(meta['detected_platforms'], ['android', 'web']);
  assert.equal(Object.hasOwn(meta, 'popularity'), false);
  assert.equal(Object.hasOwn(meta, 'retracted'), false);
});

test('PackageService keeps retracted versions orthogonal to discontinued packages and default selection', async () => {
  const pkg = {
    name: 'example',
    latest: {
      version: '1.9.0',
      pubspec: { name: 'example', version: '1.9.0' },
      published: '2024-01-01T00:00:00.000Z',
    },
    versions: [
      {
        version: '1.9.0',
        pubspec: { name: 'example', version: '1.9.0' },
        published: '2024-01-01T00:00:00.000Z',
      },
      {
        version: '2.0.0',
        pubspec: { name: 'example', version: '2.0.0' },
        published: '2024-02-01T00:00:00.000Z',
        retracted: true,
      },
    ],
    isDiscontinued: true,
    replacedBy: 'example_next',
  };
  const service = makeService({ fetchPackage: async () => pkg });

  const resource = await service.getPackageMetadata('example', 'https://registry.example.test');
  assert.equal(resource['versionid'], '1.9.0');
  assert.equal(resource['version'], '1.9.0');
  assert.equal(resource['isdefault'], true);

  const versions = await service.getPackageVersions('example', 'https://registry.example.test');
  assertVersionConforms(modelData, 'dartregistries', 'packages', versions['1.9.0'], 'pubdev.versions.1.9.0');
  assertVersionConforms(modelData, 'dartregistries', 'packages', versions['2.0.0'], 'pubdev.versions.2.0.0');
  assert.equal((versions['1.9.0'] as Record<string, unknown>)['isdefault'], true);
  assert.equal((versions['2.0.0'] as Record<string, unknown>)['isdefault'], false);
  assert.equal((versions['2.0.0'] as Record<string, unknown>)['retracted'], true);

  const meta = await service.getPackageMeta('example', 'https://registry.example.test');
  assert.equal(meta['defaultversionid'], '1.9.0');
  assert.equal(meta['is_discontinued'], true);
  assert.equal(meta['replaced_by'], 'example_next');
});

test('PackageService preserves declared_platforms map values, including nulls', async () => {
  const pkg = {
    name: 'example',
    latest: {
      version: '1.0.0',
      pubspec: {
        name: 'example',
        version: '1.0.0',
        platforms: {
          android: null,
          ios: null,
        },
      },
      published: '2024-01-01T00:00:00.000Z',
    },
    versions: [
      {
        version: '1.0.0',
        pubspec: {
          name: 'example',
          version: '1.0.0',
          platforms: {
            android: null,
            ios: null,
          },
        },
        published: '2024-01-01T00:00:00.000Z',
      },
    ],
  };
  const service = makeService({ fetchPackage: async () => pkg });
  const resource = await service.getPackageMetadata('example', 'https://registry.example.test');
  assert.deepEqual(resource['declared_platforms'], { android: null, ios: null });
});
