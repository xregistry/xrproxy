import type { CacheLoadResult } from '@xregistry/registry-core';
import { type CratesGetResult, type CratesIoOwner, type CratesIoVersion, type CratesListResult, type CratesVersionsResult } from './adapter';

/** Fixture data for deterministic testing when FIXTURE_MODE=true */

export const FIXTURE_SERDE_OWNERS_RESPONSE: { readonly users: readonly CratesIoOwner[] } = {
  users: [
    {
      id: 3618,
      login: 'dtolnay',
      kind: 'user',
      url: 'https://github.com/dtolnay',
      name: 'David Tolnay',
      avatar: 'https://avatars.githubusercontent.com/u/1940490?v=4'
    },
    {
      id: 8138,
      login: 'github:serde-rs:publish',
      kind: 'team',
      url: 'https://github.com/serde-rs',
      name: 'publish',
      avatar: 'https://avatars.githubusercontent.com/u/11965399?v=4'
    }
  ]
};

const FIXTURE_SERDE_VERSIONS_API: readonly CratesIoVersion[] = [
  {
    id: 100001,
    crate: 'serde',
    num: '1.0.219',
    dl_path: '/api/v1/crates/serde/1.0.219/download',
    readme_path: '/api/v1/crates/serde/1.0.219/readme',
    updated_at: '2025-01-01T00:00:00.000Z',
    created_at: '2025-01-01T00:00:00.000Z',
    downloads: 5_000_000,
    features: { derive: [] },
    yanked: true,
    yank_message: 'superseded by 1.0.218 for the default slot',
    lib_links: null,
    license: 'MIT OR Apache-2.0',
    links: { dependencies: '/api/v1/crates/serde/1.0.219/dependencies' },
    crate_size: 120_000,
    published_by: {
      id: 3618,
      login: 'dtolnay',
      name: 'David Tolnay',
      avatar: 'https://avatars.githubusercontent.com/u/1940490?v=4',
      url: 'https://github.com/dtolnay',
      created_at: '2012-07-09T03:55:40Z'
    },
    audit_actions: [
      {
        action: 'publish',
        time: '2025-01-01T00:00:00.000Z',
        user: {
          id: 3618,
          login: 'dtolnay',
          name: 'David Tolnay',
          avatar: 'https://avatars.githubusercontent.com/u/1940490?v=4',
          url: 'https://github.com/dtolnay',
          created_at: '2012-07-09T03:55:40Z'
        }
      },
      {
        action: 'yank',
        time: '2025-01-02T00:00:00.000Z',
        user: {
          id: 3618,
          login: 'dtolnay',
          name: 'David Tolnay',
          avatar: 'https://avatars.githubusercontent.com/u/1940490?v=4',
          url: 'https://github.com/dtolnay',
          created_at: '2012-07-09T03:55:40Z'
        }
      }
    ],
    checksum: '2192192192192192192192192192192192192192192192192192192192192192',
    rust_version: '1.56',
    has_lib: true,
    bin_names: [],
    edition: '2021',
    description: 'A generic serialization/deserialization framework',
    homepage: 'https://serde.rs',
    documentation: 'https://docs.rs/serde',
    repository: 'https://github.com/serde-rs/serde'
  },
  {
    id: 100000,
    crate: 'serde',
    num: '1.0.218',
    dl_path: '/api/v1/crates/serde/1.0.218/download',
    readme_path: '/api/v1/crates/serde/1.0.218/readme',
    updated_at: '2024-12-01T00:00:00.000Z',
    created_at: '2024-12-01T00:00:00.000Z',
    downloads: 3_000_000,
    features: { derive: [] },
    yanked: false,
    yank_message: null,
    lib_links: null,
    license: 'MIT OR Apache-2.0',
    links: { dependencies: '/api/v1/crates/serde/1.0.218/dependencies' },
    crate_size: 118_000,
    published_by: null,
    audit_actions: [
      {
        action: 'publish',
        time: '2024-12-01T00:00:00.000Z',
        user: {
          id: 3618,
          login: 'dtolnay',
          name: 'David Tolnay',
          avatar: 'https://avatars.githubusercontent.com/u/1940490?v=4',
          url: 'https://github.com/dtolnay',
          created_at: '2012-07-09T03:55:40Z'
        }
      }
    ],
    checksum: '2182182182182182182182182182182182182182182182182182182182182182',
    rust_version: '1.56',
    has_lib: true,
    bin_names: [],
    edition: '2021',
    description: 'A generic serialization/deserialization framework',
    homepage: 'https://serde.rs',
    documentation: 'https://docs.rs/serde',
    repository: 'https://github.com/serde-rs/serde'
  }
];

export const FIXTURE_SERDE_INDEX_TEXT = [
  JSON.stringify({
    name: 'serde',
    vers: '1.0.219',
    deps: [
      {
        name: 'serde_derive_alias',
        req: '^1.0',
        features: ['std'],
        optional: true,
        default_features: false,
        target: 'cfg(unix)',
        kind: 'dev',
        registry: 'https://example.invalid/index',
        package: 'serde_derive'
      }
    ],
    cksum: '2192192192192192192192192192192192192192192192192192192192192192',
    features: { derive: [] },
    yanked: true,
    rust_version: '1.56',
    v: 2,
    features2: { unstable: ['dep:serde_derive'] }
  }),
  JSON.stringify({
    name: 'serde',
    vers: '1.0.218',
    deps: [
      {
        name: 'serde_derive_alias',
        req: '^1.0',
        features: ['std'],
        optional: true,
        default_features: false,
        target: 'cfg(unix)',
        kind: 'dev',
        registry: 'https://example.invalid/index',
        package: 'serde_derive'
      }
    ],
    cksum: '2182182182182182182182182182182182182182182182182182182182182182',
    features: { derive: [] },
    yanked: false,
    rust_version: '1.56',
    v: 2,
    features2: { unstable: ['dep:serde_derive'] }
  })
].join('\n');

export const FIXTURE_CRATE_SERDE_API: CratesGetResult = {
  crate: {
    id: 'serde',
    name: 'serde',
    description: 'A generic serialization/deserialization framework',
    homepage: 'https://serde.rs',
    repository: 'https://github.com/serde-rs/serde',
    documentation: 'https://docs.rs/serde',
    categories: ['encoding', 'no-std', 'development-tools'],
    keywords: ['serde', 'serialization', 'no_std'],
    downloads: 450_000_000,
    recent_downloads: 12_000_000,
    default_version: '1.0.218',
    max_version: '1.0.219',
    max_stable_version: '1.0.219',
    newest_version: '1.0.219',
    num_versions: 2,
    yanked: false,
    trustpub_only: true,
    links: {
      version_downloads: '/api/v1/crates/serde/downloads',
      versions: '/api/v1/crates/serde/versions',
      owners: '/api/v1/crates/serde/owners',
      owner_team: '/api/v1/crates/serde/owner_team',
      owner_user: '/api/v1/crates/serde/owner_user',
      reverse_dependencies: '/api/v1/crates/serde/reverse_dependencies'
    },
    created_at: '2015-01-17T17:47:12.000Z',
    updated_at: '2025-01-02T00:00:00.000Z'
  },
  versions: FIXTURE_SERDE_VERSIONS_API,
  owners: [],
  keywords: [
    { crate_cnt: 5000, created_at: '2015-01-17T17:47:12.000Z', id: 'serde' },
    { crate_cnt: 8000, created_at: '2015-01-17T17:47:12.000Z', id: 'serialization' }
  ],
  categories: [
    { crate_cnt: 1200, created_at: '2017-01-06T01:04:46.000Z', description: 'Encoding and/or decoding data from one format to another.', id: 'encoding', slug: 'encoding' }
  ]
};

export const FIXTURE_CRATE_SERDE: CratesGetResult = {
  ...FIXTURE_CRATE_SERDE_API,
  owners: FIXTURE_SERDE_OWNERS_RESPONSE.users,
  versions: FIXTURE_SERDE_VERSIONS_API.map(version => ({
    ...version,
    dependencies: [
      {
        name: 'serde_derive_alias',
        req: '^1.0',
        features: ['std'],
        optional: true,
        default_features: false,
        target: 'cfg(unix)',
        kind: 'dev',
        registry: 'https://example.invalid/index',
        package: 'serde_derive'
      }
    ],
    cksum: version.num === '1.0.219'
      ? '2192192192192192192192192192192192192192192192192192192192192192'
      : '2182182182182182182182182182182182182182182182182182182182182182',
    features2: { unstable: ['dep:serde_derive'] },
    v: 2
  }))
};

export const FIXTURE_CRATE_TOKIO: CratesGetResult = {
  crate: {
    id: 'tokio',
    name: 'tokio',
    description: 'An event-driven, non-blocking I/O platform for writing asynchronous I/O backed applications.',
    homepage: 'https://tokio.rs',
    repository: 'https://github.com/tokio-rs/tokio',
    documentation: 'https://docs.rs/tokio',
    categories: ['asynchronous', 'network-programming', 'concurrency'],
    keywords: ['async', 'futures', 'io', 'non-blocking', 'tokio'],
    downloads: 350_000_000,
    recent_downloads: 10_000_000,
    default_version: '1.45.1+exp.sha.1',
    max_version: '1.45.1+exp.sha.1',
    max_stable_version: '1.45.1+exp.sha.1',
    newest_version: '1.45.1+exp.sha.1',
    num_versions: 1,
    yanked: false,
    trustpub_only: false,
    links: {
      version_downloads: '/api/v1/crates/tokio/downloads',
      versions: '/api/v1/crates/tokio/versions',
      owners: '/api/v1/crates/tokio/owners',
      owner_team: null,
      owner_user: null,
      reverse_dependencies: '/api/v1/crates/tokio/reverse_dependencies'
    },
    created_at: '2016-08-18T20:21:39.000Z',
    updated_at: '2025-02-01T00:00:00.000Z'
  },
  versions: [
    {
      id: 200001,
      crate: 'tokio',
      num: '1.45.1+exp.sha.1',
      dl_path: '/api/v1/crates/tokio/1.45.1+exp.sha.1/download',
      readme_path: '/api/v1/crates/tokio/1.45.1+exp.sha.1/readme',
      updated_at: '2025-02-01T00:00:00.000Z',
      created_at: '2025-02-01T00:00:00.000Z',
      downloads: 4_000_000,
      features: { full: [], macros: [], sync: [], io: [], net: [], time: [], rt: [] },
      features2: { unstable: ['dep:tokio-macros'] },
      v: 2,
      yanked: false,
      yank_message: null,
      lib_links: 'tokio_native',
      license: 'MIT',
      links: { dependencies: '/api/v1/crates/tokio/1.45.1+exp.sha.1/dependencies' },
      crate_size: 200_000,
      published_by: { id: 2, login: 'carllerche', name: 'Carl Lerche', avatar: null, url: 'https://github.com/carllerche' },
      audit_actions: [{ action: 'publish', time: '2025-02-01T00:00:00.000Z', user: { id: 2, login: 'carllerche', name: 'Carl Lerche', avatar: null, url: 'https://github.com/carllerche' } }],
      checksum: 'tokiotokiotokiotokiotokiotokiotokiotokiotokiotokiotokiotokiotokio',
      cksum: 'tokiotokiotokiotokiotokiotokiotokiotokiotokiotokiotokiotokiotokio',
      rust_version: '1.75',
      has_lib: true,
      bin_names: [],
      edition: '2021',
      description: 'An event-driven, non-blocking I/O platform for writing asynchronous I/O backed applications.',
      homepage: 'https://tokio.rs',
      documentation: 'https://docs.rs/tokio',
      repository: 'https://github.com/tokio-rs/tokio',
      dependencies: [{ name: 'bytes', req: '^1', features: [], optional: false, default_features: true, target: null, kind: 'normal' }]
    }
  ],
  owners: [
    {
      id: 2,
      login: 'carllerche',
      kind: 'user',
      url: 'https://github.com/carllerche',
      name: 'Carl Lerche',
      avatar: null
    }
  ],
  keywords: [
    { crate_cnt: 2000, created_at: '2016-08-18T20:21:39.000Z', id: 'async' }
  ],
  categories: [
    { crate_cnt: 500, created_at: '2017-01-06T01:04:46.000Z', description: 'Async programming.', id: 'asynchronous', slug: 'asynchronous' }
  ]
};

export const FIXTURE_LIST: CratesListResult = {
  crates: [FIXTURE_CRATE_SERDE_API.crate, FIXTURE_CRATE_TOKIO.crate],
  meta: { total: 2, next_page: null, prev_page: null }
};

export const FIXTURE_VERSIONS_SERDE: CratesVersionsResult = {
  versions: FIXTURE_CRATE_SERDE.versions,
  meta: { total: 2, next_page: null, prev_page: null }
};

const FIXTURES_BY_NAME: Readonly<Record<string, CratesGetResult>> = {
  serde: FIXTURE_CRATE_SERDE,
  tokio: FIXTURE_CRATE_TOKIO
};

const VERSIONS_BY_NAME: Readonly<Record<string, CratesVersionsResult>> = {
  serde: FIXTURE_VERSIONS_SERDE,
  tokio: { versions: FIXTURE_CRATE_TOKIO.versions, meta: { total: 1, next_page: null, prev_page: null } }
};

/** In-memory fixture adapter that replaces the real crates.io API adapter */
export class FixtureAdapter {
  async listCrates(options: {
    readonly page?: number;
    readonly perPage?: number;
    readonly query?: string;
    readonly sort?: string;
    readonly etag?: string;
    readonly lastModified?: string;
  } = {}): Promise<CacheLoadResult<CratesListResult>> {
    const crates = FIXTURE_LIST.crates.filter(crate => {
      if (!options.query) {
        return true;
      }
      const query = options.query.toLowerCase();
      return crate.name.toLowerCase().includes(query);
    });
    const perPage = options.perPage ?? crates.length;
    const start = ((options.page ?? 1) - 1) * perPage;
    return {
      kind: 'value',
      value: {
        crates: crates.slice(start, start + perPage),
        meta: { total: crates.length }
      }
    };
  }

  async getCrate(
    name: string,
    _options: { readonly etag?: string; readonly lastModified?: string } = {}
  ): Promise<CacheLoadResult<CratesGetResult>> {
    const fixture = FIXTURES_BY_NAME[name];
    if (!fixture) return { kind: 'not-found' };
    return { kind: 'value', value: fixture };
  }

  async getCrateVersions(
    name: string,
    _options: { readonly page?: number; readonly perPage?: number; readonly etag?: string; readonly lastModified?: string } = {}
  ): Promise<CacheLoadResult<CratesVersionsResult>> {
    const fixture = VERSIONS_BY_NAME[name];
    if (!fixture) return { kind: 'not-found' };
    return { kind: 'value', value: fixture };
  }
}
