/**
 * Unit tests for CheckpointService.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointService } from '../src/services/checkpoint-service';

let tmpDir: string;
let svc: CheckpointService;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gomod-test-'));
    svc = new CheckpointService(tmpDir);
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CheckpointService', () => {
    it('starts empty', () => {
        expect(svc.getModuleCount()).toBe(0);
        expect(svc.hasModules()).toBe(false);
    });

    it('merges index entries', () => {
        svc.mergeEntries([
            { path: 'github.com/pkg/errors', version: 'v0.9.0', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'github.com/pkg/errors', version: 'v0.9.1', timestamp: '2020-02-01T00:00:00Z' },
            { path: 'github.com/gorilla/mux', version: 'v1.8.0', timestamp: '2021-01-01T00:00:00Z' },
        ]);
        expect(svc.getModuleCount()).toBe(2);
        expect(svc.getEntryCount()).toBe(3);
    });

    it('tracks the latest version by timestamp', () => {
        svc.mergeEntries([
            { path: 'github.com/pkg/errors', version: 'v0.9.0', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'github.com/pkg/errors', version: 'v0.9.1', timestamp: '2020-02-01T00:00:00Z' },
        ]);
        const entry = svc.getModule('github.com/pkg/errors');
        expect(entry?.latestVersion).toBe('v0.9.1');
        expect(entry?.versions).toHaveLength(2);
    });

    it('does not duplicate versions', () => {
        svc.mergeEntries([
            { path: 'github.com/pkg/errors', version: 'v0.9.1', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'github.com/pkg/errors', version: 'v0.9.1', timestamp: '2020-01-01T00:00:00Z' },
        ]);
        expect(svc.getModule('github.com/pkg/errors')?.versions).toHaveLength(1);
    });

    it('dedups overlapping entries at an equal-timestamp full-page boundary (cursor fix)', () => {
        // First page fills exactly, all sharing one timestamp.
        const page1 = [
            { path: 'a.io/x', version: 'v1.0.0', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'a.io/x', version: 'v1.1.0', timestamp: '2020-01-01T00:00:00Z' },
        ];
        expect(svc.mergeEntries(page1)).toBe(2);
        expect(svc.getEntryCount()).toBe(2);

        // The cursor stays at the same timestamp, so the next page overlaps the
        // previous one. Overlapping pairs must NOT inflate entryCount.
        const page2 = [
            { path: 'a.io/x', version: 'v1.1.0', timestamp: '2020-01-01T00:00:00Z' }, // seen
            { path: 'a.io/x', version: 'v1.2.0', timestamp: '2020-01-01T00:00:00Z' }, // new
        ];
        expect(svc.mergeEntries(page2)).toBe(1);
        expect(svc.getEntryCount()).toBe(3);
        expect(svc.getModule('a.io/x')?.versions).toHaveLength(3);
    });

    it('rebuilds the dedup set from a persisted catalog', () => {
        svc.mergeEntries([{ path: 'b.io/y', version: 'v2.0.0', timestamp: '2021-01-01T00:00:00Z' }]);
        svc.save();
        expect(svc.getEntryCount()).toBe(1);

        const reloaded = new CheckpointService(tmpDir);
        // Re-merging an already-persisted pair is a no-op for entryCount.
        expect(reloaded.mergeEntries([{ path: 'b.io/y', version: 'v2.0.0', timestamp: '2021-01-01T00:00:00Z' }])).toBe(0);
        expect(reloaded.getEntryCount()).toBe(1);
        expect(reloaded.getModule('b.io/y')?.versions).toHaveLength(1);
    });

    it('persists and reloads catalog', () => {
        svc.mergeEntries([
            { path: 'github.com/pkg/errors', version: 'v0.9.1', timestamp: '2020-01-01T00:00:00Z' },
        ]);
        svc.updateCheckpoint('2020-02-01T00:00:00Z');
        svc.save();

        const svc2 = new CheckpointService(tmpDir);
        expect(svc2.getModuleCount()).toBe(1);
        expect(svc2.getCheckpoint().since).toBe('2020-02-01T00:00:00Z');
    });

    it('lists paths with pagination', () => {
        svc.mergeEntries([
            { path: 'a.io/foo', version: 'v1.0.0', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'b.io/bar', version: 'v1.0.0', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'c.io/baz', version: 'v1.0.0', timestamp: '2020-01-01T00:00:00Z' },
        ]);
        const { paths, totalKnown } = svc.listModulePaths(0, 2);
        expect(totalKnown).toBe(3);
        expect(paths).toHaveLength(2);
        expect(paths[0]).toBe('a.io/foo');
    });

    it('groups modules by the first module-path component', () => {
        svc.mergeEntries([
            { path: 'github.com/pkg/errors', version: 'v0.9.1', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'github.com/gorilla/mux', version: 'v1.8.0', timestamp: '2021-01-01T00:00:00Z' },
            { path: 'golang.org/x/net', version: 'v0.1.0', timestamp: '2022-01-01T00:00:00Z' },
        ]);

        expect(svc.listGroupIds(0, 10)).toEqual({
            groupIds: ['github.com', 'golang.org'],
            totalKnown: 2,
        });
        expect(svc.getGroupModuleCount('github.com')).toBe(2);
        expect(svc.listGroupModulePaths('github.com', undefined, 0, 10).paths).toEqual([
            'github.com/gorilla/mux',
            'github.com/pkg/errors',
        ]);
    });

    it('filters by substring', () => {
        svc.mergeEntries([
            { path: 'github.com/pkg/errors', version: 'v0.9.1', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'github.com/gorilla/mux', version: 'v1.8.0', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'golang.org/x/net', version: 'v0.0.0-20210101000000-aabbccdd1234', timestamp: '2021-01-01T00:00:00Z' },
        ]);
        const { paths, totalMatched } = svc.filterModulePaths('github.com', 0, 10);
        expect(totalMatched).toBe(2);
        expect(paths.every((p) => p.startsWith('github.com'))).toBe(true);
    });

    it('filters by glob pattern', () => {
        svc.mergeEntries([
            { path: 'github.com/pkg/errors', version: 'v0.9.1', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'github.com/gorilla/mux', version: 'v1.8.0', timestamp: '2020-01-01T00:00:00Z' },
        ]);
        const { totalMatched } = svc.filterModulePaths('github.com/*/mux', 0, 10);
        expect(totalMatched).toBe(1);
    });

    it('treats non-wildcard regex characters literally in filters', () => {
        svc.mergeEntries([
            { path: 'github.com/a.b/module', version: 'v1.0.0', timestamp: '2020-01-01T00:00:00Z' },
            { path: 'github.com/acb/module', version: 'v1.0.0', timestamp: '2020-01-01T00:00:00Z' },
        ]);

        expect(svc.listGroupModulePaths('github.com', 'github.com/a.b/*', 0, 10).paths).toEqual([
            'github.com/a.b/module',
        ]);
        expect(svc.listGroupModulePaths('github.com', '*[*', 0, 10).paths).toEqual([]);
    });
});
