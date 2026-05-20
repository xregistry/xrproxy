/**
 * Search Service
 * @fileoverview Direct Maven Central Solr Search API client.
 *
 * Replaces the old SQLite-backed lookup with a thin Solr proxy. The full
 * Maven Central index is ~660k coordinates and is hosted by Sonatype
 * behind https://search.maven.org/solrsearch/select; we have no reason
 * to re-host it. Responses are deduplicated and cached by `MavenService`
 * (file-backed, 1h TTL) so repeated queries are local-disk-fast.
 *
 * For unit/integration tests, `MAVEN_USE_TEST_INDEX=true` switches the
 * service to an in-memory fixture (`stub-catalog.ts`) so CI doesn't hit
 * the network.
 */

import { MAX_SOLR_ROWS } from '../config/constants';
import { MavenService } from './maven-service';
import { STUB_CATALOG } from './stub-catalog';

export interface SearchServiceOptions {
    mavenService: MavenService;
    /**
     * Force the offline stub catalog. Falls back to the
     * MAVEN_USE_TEST_INDEX env var when unset.
     */
    useTestFixture?: boolean;
}

export interface SearchResult {
    groupId: string;
    artifactId: string;
    latestVersion: string;
    timestamp: number;
    repositoryId: string;
    versionCount: number;
}

export interface SearchOptions {
    /** Free-text query (default core). Empty / undefined => list all. */
    query?: string;
    /** Maximum rows to return. Hard-capped at MAX_SOLR_ROWS (200). */
    limit?: number;
    /** Solr `start` offset. Solr paginates cleanly to end of result set. */
    offset?: number;
}

export interface SearchPackagesResult {
    results: SearchResult[];
    /** Total matching results across all pages (Solr `numFound`). */
    totalCount: number;
}

const TOTAL_COUNT_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Service for searching Maven packages via Maven Central's Solr API.
 */
export class SearchService {
    private readonly mavenService: MavenService;
    private readonly useTestFixture: boolean;
    private cachedTotal: { value: number; expiresAt: number } | null = null;

    constructor(options: SearchServiceOptions) {
        this.mavenService = options.mavenService;
        this.useTestFixture =
            options.useTestFixture ?? process.env['MAVEN_USE_TEST_INDEX'] === 'true';
    }

    /**
     * No-op retained so callers that previously initialised SQLite still
     * compile. Solr-direct mode has no local state to set up.
     */
    async initializeDatabase(): Promise<void> {
        return;
    }

    /**
     * No-op for symmetry with the old SQLite-backed close().
     */
    async close(): Promise<void> {
        return;
    }

    /** True when running against the in-memory fixture, not live Solr. */
    isUsingTestFixture(): boolean {
        return this.useTestFixture;
    }

    /**
     * Translate an xRegistry-style filter pattern into a Solr query. The
     * route layer already strips quotes; this just handles wildcards and
     * the bare-term case.
     */
    private translateFilterToSolr(pattern: string): string {
        const trimmed = pattern.trim();
        if (!trimmed || trimmed === '*' || trimmed === '*:*') {
            return '*:*';
        }
        // Wildcard pattern: try artifactId match first, then groupId.
        // Solr default core indexes both as analysed text plus an exact
        // `a` and `g` field, so prefix/contains both work.
        if (trimmed.includes('*')) {
            return `(a:${trimmed} OR g:${trimmed})`;
        }
        // Bare term: default analyser does the right thing.
        return trimmed;
    }

    /**
     * Search packages. Translates an xRegistry-style query/filter into a
     * Solr query, fetches up to `limit` rows, and returns the live total.
     */
    async searchPackages(options: SearchOptions = {}): Promise<SearchPackagesResult> {
        const rawLimit = options.limit ?? 50;
        const limit = Math.max(1, Math.min(MAX_SOLR_ROWS, rawLimit));
        const offset = Math.max(0, options.offset ?? 0);
        const query = this.translateFilterToSolr(options.query ?? '*:*');

        if (this.useTestFixture) {
            return this.searchStub(query, limit, offset);
        }

        const response = await this.mavenService.solrQuery({
            q: query,
            rows: limit,
            start: offset
        });

        const results: SearchResult[] = response.response.docs.map((doc) => ({
            groupId: doc.g,
            artifactId: doc.a,
            latestVersion: doc.latestVersion,
            timestamp: doc.timestamp,
            repositoryId: doc.repositoryId || 'central',
            versionCount: typeof doc.versionCount === 'number' ? doc.versionCount : 0
        }));

        return {
            results,
            totalCount: response.response.numFound
        };
    }

    /**
     * Total number of coordinates in Maven Central. Cached for an hour
     * because this is metadata, not transactional.
     */
    async getTotalCount(): Promise<number> {
        if (this.useTestFixture) {
            return STUB_CATALOG.length;
        }

        const now = Date.now();
        if (this.cachedTotal && this.cachedTotal.expiresAt > now) {
            return this.cachedTotal.value;
        }

        try {
            const response = await this.mavenService.solrQuery({
                q: '*:*',
                rows: 0
            });
            this.cachedTotal = {
                value: response.response.numFound,
                expiresAt: now + TOTAL_COUNT_TTL_MS
            };
            return response.response.numFound;
        } catch {
            // Graceful degradation: if we have a stale value, use it;
            // otherwise return 0 so the registry endpoints stay up.
            return this.cachedTotal?.value ?? 0;
        }
    }

    private searchStub(query: string, limit: number, offset: number): SearchPackagesResult {
        const filtered = this.filterStub(query);
        return {
            results: filtered.slice(offset, offset + limit),
            totalCount: filtered.length
        };
    }

    private filterStub(query: string): SearchResult[] {
        if (query === '*:*') {
            return STUB_CATALOG;
        }
        const lower = query.toLowerCase();
        // Strip parenthesised "(a:foo OR g:foo)" form back to a plain term.
        const fieldQuery = lower.match(/[ag]:([^\s)]+)/);
        const needle = (fieldQuery?.[1] ?? lower).replace(/\*/g, '');
        if (!needle) {
            return STUB_CATALOG;
        }
        return STUB_CATALOG.filter(
            (r) =>
                r.groupId.toLowerCase().includes(needle) ||
                r.artifactId.toLowerCase().includes(needle)
        );
    }
}
