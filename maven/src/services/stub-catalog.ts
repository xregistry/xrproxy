/**
 * Offline test catalog used when MAVEN_USE_TEST_INDEX=true. Mirrors the
 * shape of Maven Central's Solr default-core response so the route handlers
 * exercise the same code paths against deterministic data.
 */

import type { SearchResult } from './search-service';

export const STUB_CATALOG: SearchResult[] = [
    {
        groupId: 'com.fasterxml.jackson.core',
        artifactId: 'jackson-annotations',
        latestVersion: '2.17.2',
        timestamp: 1721066400000,
        repositoryId: 'central',
        versionCount: 142
    },
    {
        groupId: 'com.fasterxml.jackson.core',
        artifactId: 'jackson-core',
        latestVersion: '2.17.2',
        timestamp: 1721066400000,
        repositoryId: 'central',
        versionCount: 140
    },
    {
        groupId: 'com.fasterxml.jackson.core',
        artifactId: 'jackson-databind',
        latestVersion: '2.17.2',
        timestamp: 1721066400000,
        repositoryId: 'central',
        versionCount: 158
    },
    {
        groupId: 'com.google.guava',
        artifactId: 'guava',
        latestVersion: '33.3.0-jre',
        timestamp: 1724112000000,
        repositoryId: 'central',
        versionCount: 211
    },
    {
        groupId: 'junit',
        artifactId: 'junit',
        latestVersion: '4.13.2',
        timestamp: 1613563200000,
        repositoryId: 'central',
        versionCount: 49
    },
    {
        groupId: 'org.apache.commons',
        artifactId: 'commons-lang3',
        latestVersion: '3.17.0',
        timestamp: 1724803200000,
        repositoryId: 'central',
        versionCount: 23
    },
    {
        groupId: 'org.junit.jupiter',
        artifactId: 'junit-jupiter-api',
        latestVersion: '5.11.0',
        timestamp: 1724803200000,
        repositoryId: 'central',
        versionCount: 86
    },
    {
        groupId: 'org.springframework',
        artifactId: 'spring-core',
        latestVersion: '6.1.13',
        timestamp: 1726099200000,
        repositoryId: 'central',
        versionCount: 412
    },
    {
        groupId: 'org.springframework',
        artifactId: 'spring-web',
        latestVersion: '6.1.13',
        timestamp: 1726099200000,
        repositoryId: 'central',
        versionCount: 387
    },
    {
        groupId: 'org.springframework.boot',
        artifactId: 'spring-boot-starter',
        latestVersion: '3.3.4',
        timestamp: 1726099200000,
        repositoryId: 'central',
        versionCount: 195
    }
];
