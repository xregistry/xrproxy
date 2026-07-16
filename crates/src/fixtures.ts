import { type CratesGetResult, type CratesListResult, type CratesVersionsResult } from './adapter';

/** Fixture data for deterministic testing when FIXTURE_MODE=true */

export const FIXTURE_CRATE_SERDE: CratesGetResult = {
  crate: {
    id: 'serde',
    name: 'serde',
    description: 'A generic serialization/deserialization framework',
    homepage: 'https://serde.rs',
    repository: 'https://github.com/serde-rs/serde',
    documentation: 'https://docs.rs/serde',
    categories: ['encoding', 'no-std', 'development-tools'],
    keywords: ['serde', 'serialization', 'no_std'],
    downloads: 450000000,
    recent_downloads: 12000000,
    max_version: '1.0.219',
    max_stable_version: '1.0.219',
    newest_version: '1.0.219',
    yanked: false,
    license: 'MIT OR Apache-2.0',
    links: {
      version_downloads: '/api/v1/crates/serde/downloads',
      versions: '/api/v1/crates/serde/versions',
      owners: '/api/v1/crates/serde/owners',
      owner_team: '/api/v1/crates/serde/owner_team',
      owner_user: '/api/v1/crates/serde/owner_user',
      reverse_dependencies: '/api/v1/crates/serde/reverse_dependencies'
    },
    created_at: '2015-01-17T17:47:12.000Z',
    updated_at: '2025-01-01T00:00:00.000Z'
  },
  versions: [
    {
      id: 100001,
      crate: 'serde',
      num: '1.0.219',
      dl_path: '/api/v1/crates/serde/1.0.219/download',
      readme_path: '/api/v1/crates/serde/1.0.219/readme',
      updated_at: '2025-01-01T00:00:00.000Z',
      created_at: '2025-01-01T00:00:00.000Z',
      downloads: 5000000,
      features: { derive: [] },
      yanked: false,
      license: 'MIT OR Apache-2.0',
      links: { dependencies: '/api/v1/crates/serde/1.0.219/dependencies' },
      crate_size: 120000,
      published_by: { id: 1, login: 'dtolnay', name: 'David Tolnay', avatar: null, url: 'https://github.com/dtolnay' },
      audit_actions: []
    },
    {
      id: 100000,
      crate: 'serde',
      num: '1.0.218',
      dl_path: '/api/v1/crates/serde/1.0.218/download',
      readme_path: null,
      updated_at: '2024-12-01T00:00:00.000Z',
      created_at: '2024-12-01T00:00:00.000Z',
      downloads: 3000000,
      features: { derive: [] },
      yanked: false,
      license: 'MIT OR Apache-2.0',
      links: { dependencies: '/api/v1/crates/serde/1.0.218/dependencies' },
      crate_size: 118000,
      published_by: null,
      audit_actions: []
    }
  ],
  keywords: [
    { crate_cnt: 5000, created_at: '2015-01-17T17:47:12.000Z', id: 'serde' },
    { crate_cnt: 8000, created_at: '2015-01-17T17:47:12.000Z', id: 'serialization' }
  ],
  categories: [
    { crate_cnt: 1200, created_at: '2017-01-06T01:04:46.000Z', description: 'Encoding and/or decoding data from one format to another.', id: 'encoding', slug: 'encoding' }
  ]
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
    downloads: 350000000,
    recent_downloads: 10000000,
    max_version: '1.45.1',
    max_stable_version: '1.45.1',
    newest_version: '1.45.1',
    yanked: false,
    license: 'MIT',
    links: {
      version_downloads: '/api/v1/crates/tokio/downloads',
      versions: '/api/v1/crates/tokio/versions',
      owners: null,
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
      num: '1.45.1',
      dl_path: '/api/v1/crates/tokio/1.45.1/download',
      readme_path: '/api/v1/crates/tokio/1.45.1/readme',
      updated_at: '2025-02-01T00:00:00.000Z',
      created_at: '2025-02-01T00:00:00.000Z',
      downloads: 4000000,
      features: { full: [], macros: [], sync: [], io: [], net: [], time: [], rt: [] },
      yanked: false,
      license: 'MIT',
      links: { dependencies: '/api/v1/crates/tokio/1.45.1/dependencies' },
      crate_size: 200000,
      published_by: { id: 2, login: 'carllerche', name: 'Carl Lerche', avatar: null, url: 'https://github.com/carllerche' },
      audit_actions: []
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
  crates: [FIXTURE_CRATE_SERDE.crate, FIXTURE_CRATE_TOKIO.crate],
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
  async listCrates(_options: {
    readonly page?: number;
    readonly perPage?: number;
    readonly query?: string;
  } = {}): Promise<{ kind: 'value'; value: CratesListResult }> {
    return { kind: 'value', value: FIXTURE_LIST };
  }

  async getCrate(name: string): Promise<{ kind: 'value'; value: CratesGetResult } | { kind: 'not-found' }> {
    const fixture = FIXTURES_BY_NAME[name];
    if (!fixture) return { kind: 'not-found' };
    return { kind: 'value', value: fixture };
  }

  async getCrateVersions(name: string): Promise<{ kind: 'value'; value: CratesVersionsResult } | { kind: 'not-found' }> {
    const fixture = VERSIONS_BY_NAME[name];
    if (!fixture) return { kind: 'not-found' };
    return { kind: 'value', value: fixture };
  }
}
