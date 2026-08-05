/**
 * Search Service
 * @fileoverview Direct Maven Central Solr Search API client.
 */

import { MAX_SOLR_ROWS } from '../config/constants';
import { buildNamespaceIdMap, isVerbatimEntityId } from '../utils/maven-identity';
import { MavenService } from './maven-service';
import { STUB_CATALOG } from './stub-catalog';

export interface SearchServiceOptions {
    mavenService: MavenService;
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

export interface NamespaceSearchResult {
    groupId: string;
    namespaceId: string;
    packageCount: number;
}

export interface SearchOptions {
    query?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
}

export interface SearchPackagesResult {
    results: SearchResult[];
    totalCount: number;
}

export interface SearchNamespacesResult {
    results: NamespaceSearchResult[];
    totalCount: number;
}

const TOTAL_COUNT_TTL_MS = 60 * 60 * 1000;

export class SearchService {
    private readonly mavenService: MavenService;
    private readonly useTestFixture: boolean;
    private cachedTotal: { value: number; expiresAt: number } | null = null;

    constructor(options: SearchServiceOptions) {
        this.mavenService = options.mavenService;
        this.useTestFixture = options.useTestFixture ?? process.env['MAVEN_USE_TEST_INDEX'] === 'true';
    }

    async initializeDatabase(): Promise<void> {
        return;
    }

    async close(): Promise<void> {
        return;
    }

    isUsingTestFixture(): boolean {
        return this.useTestFixture;
    }

    private translateFilterToSolr(pattern: string): string {
        const trimmed = pattern.trim();
        if (!trimmed || trimmed === '*' || trimmed === '*:*') {
            return '*:*';
        }
        if (trimmed.includes('*')) {
            return `(a:${trimmed} OR g:${trimmed})`;
        }
        return trimmed;
    }

    async searchPackages(options: SearchOptions = {}): Promise<SearchPackagesResult> {
        const rawLimit = options.limit ?? 50;
        const limit = Math.max(1, Math.min(MAX_SOLR_ROWS, rawLimit));
        const offset = Math.max(0, options.offset ?? 0);
        const query = this.translateFilterToSolr(options.query ?? '*:*');

        if (this.useTestFixture) {
            return this.searchStub(query, limit, offset);
        }

        const response = await this.mavenService.solrQuery({ q: query, rows: limit, start: offset });
        const results: SearchResult[] = response.response.docs.map((doc) => ({
            groupId: doc.g,
            artifactId: doc.a,
            latestVersion: doc.latestVersion,
            timestamp: doc.timestamp,
            repositoryId: doc.repositoryId || 'central',
            versionCount: typeof doc.versionCount === 'number' ? doc.versionCount : 0
        }));

        return { results, totalCount: response.response.numFound };
    }

    async searchPackagesInNamespace(groupId: string, options: SearchOptions = {}): Promise<SearchPackagesResult> {
        const query = options.query?.trim();
        const namespaceQuery = `g:"${groupId}"`;
        const combinedQuery = query && query !== '*' && query !== '*:*'
            ? `${namespaceQuery} AND (${this.translateFilterToSolr(query)})`
            : namespaceQuery;

        const searchOptions: SearchOptions = { query: combinedQuery };
        if (options.limit !== undefined) searchOptions.limit = options.limit;
        if (options.offset !== undefined) searchOptions.offset = options.offset;
        return this.searchPackages(searchOptions);
    }

    async listNamespaces(options: SearchOptions = {}): Promise<SearchNamespacesResult> {
        const limit = Math.max(1, options.limit ?? 50);
        const offset = Math.max(0, options.offset ?? 0);
        const namespaceIndex = this.useTestFixture ? null : await this.mavenService.fetchNamespaceIndex();
        const allGroupIds = namespaceIndex?.ids ?? this.getStubGroupIds();
        const idMap = buildNamespaceIdMap(allGroupIds);
        const query = options.query?.trim().toLowerCase();

        const filtered = allGroupIds
            .filter((groupId) => idMap.has(groupId))
            .filter((groupId) => {
                if (!query || query === '*' || query === '*:*') {
                    return true;
                }
                const wildcard = query.replace(/\*/g, '');
                return !wildcard || groupId.toLowerCase().includes(wildcard);
            })
            .sort((left, right) => left.localeCompare(right))
            .map((groupId) => ({
                groupId,
                namespaceId: idMap.get(groupId) || groupId,
                packageCount: namespaceIndex?.counts.get(groupId)
                    ?? STUB_CATALOG.filter((entry) => entry.groupId === groupId).length,
            }));

        return {
            results: filtered.slice(offset, offset + limit),
            totalCount: filtered.length
        };
    }

    async getNamespaceById(namespaceId: string): Promise<NamespaceSearchResult | null> {
        if (!this.useTestFixture && isVerbatimEntityId(namespaceId)) {
            const count = await this.countPackagesInNamespace(namespaceId);
            return count > 0 ? { groupId: namespaceId, namespaceId, packageCount: count } : null;
        }
        const allGroupIds = this.useTestFixture ? this.getStubGroupIds() : await this.mavenService.fetchAllNamespaceIds();
        const idMap = buildNamespaceIdMap(allGroupIds);
        for (const groupId of allGroupIds) {
            if (idMap.get(groupId) === namespaceId) {
                return {
                    groupId,
                    namespaceId,
                    packageCount: this.useTestFixture
                        ? STUB_CATALOG.filter((entry) => entry.groupId === groupId).length
                        : (await this.mavenService.fetchNamespaceIndex()).counts.get(groupId) ?? 0,
                };
            }
        }
        return null;
    }

    async getNamespaceByGroupId(groupId: string): Promise<NamespaceSearchResult | null> {
        const allGroupIds = this.useTestFixture ? this.getStubGroupIds() : await this.mavenService.fetchAllNamespaceIds();
        const idMap = buildNamespaceIdMap(allGroupIds);
        const namespaceId = idMap.get(groupId);
        if (!namespaceId) return null;
        return {
            groupId,
            namespaceId,
            packageCount: this.useTestFixture
                ? STUB_CATALOG.filter((entry) => entry.groupId === groupId).length
                : (await this.mavenService.fetchNamespaceIndex()).counts.get(groupId) ?? 0,
        };
    }

    async countPackagesInNamespace(groupId: string): Promise<number> {
        if (this.useTestFixture) {
            return STUB_CATALOG.filter((entry) => entry.groupId === groupId).length;
        }
        const response = await this.mavenService.solrQuery({ q: `g:"${groupId}"`, rows: 0 });
        return response.response.numFound;
    }

    async getTotalCount(): Promise<number> {
        if (this.useTestFixture) {
            return STUB_CATALOG.length;
        }
        const now = Date.now();
        if (this.cachedTotal && this.cachedTotal.expiresAt > now) {
            return this.cachedTotal.value;
        }
        try {
            const response = await this.mavenService.solrQuery({ q: '*:*', rows: 0 });
            this.cachedTotal = { value: response.response.numFound, expiresAt: now + TOTAL_COUNT_TTL_MS };
            return response.response.numFound;
        } catch {
            return this.cachedTotal?.value ?? 0;
        }
    }

    private getStubGroupIds(): string[] {
        return Array.from(new Set(STUB_CATALOG.map((entry) => entry.groupId))).sort((left, right) => left.localeCompare(right));
    }

    private searchStub(query: string, limit: number, offset: number): SearchPackagesResult {
        const filtered = this.filterStub(query);
        return { results: filtered.slice(offset, offset + limit), totalCount: filtered.length };
    }

    private filterStub(query: string): SearchResult[] {
        if (query === '*:*') {
            return STUB_CATALOG;
        }

        const exactGroupMatch = query.match(/g:\"([^\"]+)\"/i);
        const lower = query.toLowerCase();
        const fieldQuery = lower.match(/[ag]:([^\s)]+)/);
        const needle = (fieldQuery?.[1] ?? lower).replace(/\*/g, '');

        return STUB_CATALOG.filter((entry) => {
            const groupMatches = exactGroupMatch ? entry.groupId === exactGroupMatch[1] : true;
            if (!groupMatches) {
                return false;
            }
            return !needle || needle === '*:*' || entry.groupId.toLowerCase().includes(needle) || entry.artifactId.toLowerCase().includes(needle);
        });
    }
}
