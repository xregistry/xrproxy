/**
 * pub_semver ordering tests — numeric-aware prerelease and build metadata
 * All inputs are presented in both forward and reversed order to catch
 * sort-direction bugs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions } from '../../src/services/pubdev-service';

function sorted(...versions: string[]): string[] {
  return [...versions].sort(compareVersions);
}

// Provide both orderings so bugs in the comparator (sign flip, etc.) are caught
function sortedReversed(...versions: string[]): string[] {
  return [...versions].reverse().sort(compareVersions);
}

function assertOrder(ordered: string[], desc: string): void {
  for (let i = 0; i + 1 < ordered.length; i++) {
    const cmp = compareVersions(ordered[i]!, ordered[i + 1]!);
    assert.ok(cmp <= 0, `${desc}: expected ${ordered[i]} <= ${ordered[i + 1]} (got ${cmp})`);
  }
}

// ── Release ordering ─────────────────────────────────────────────────────────

test('release triple: major.minor.patch ordered numerically', () => {
  const expected = ['1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  assertOrder(expected, 'forward');
  assertOrder(sortedReversed(...expected), 'reversed');
});

// ── Prerelease ordering ───────────────────────────────────────────────────────

test('prerelease < its stable counterpart', () => {
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-alpha'), 1);
});

test('prerelease dot components are compared numerically: rc.9 < rc.10', () => {
  // Regression: lexicographic comparison would give rc.9 > rc.10 ("9" > "1")
  const expected = ['1.0.0-rc.9', '1.0.0-rc.10'];
  assertOrder(sorted(...expected), 'forward');
  assertOrder(sortedReversed(...expected), 'reversed');
  assert.equal(compareVersions('1.0.0-rc.9', '1.0.0-rc.10'), -1);
});

test('prerelease alpha < beta < rc, lexicographic for pure-alpha identifiers', () => {
  const expected = ['1.0.0-alpha', '1.0.0-beta', '1.0.0-rc'];
  assertOrder(sorted(...expected), 'forward');
  assertOrder(sortedReversed(...expected), 'reversed');
});

test('prerelease: shorter identifier list beats longer when all shared are equal', () => {
  // semver §11.4.4: rc < rc.1 (rc has fewer identifiers)
  assert.equal(compareVersions('1.0.0-rc', '1.0.0-rc.1'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc'), 1);
});

test('prerelease numeric identifier < alphanumeric (semver §11.4.1.3)', () => {
  // "1" (numeric) < "alpha" (alphanumeric)
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
});

test('null-safe: prerelease present after same release sorts before release', () => {
  const order = sorted('1.0.0', '1.0.0-beta', '1.0.0-rc.1', '1.0.0-rc.9', '1.0.0-rc.10');
  assert.equal(order[0], '1.0.0-beta');
  assert.ok(order.indexOf('1.0.0-rc.9') < order.indexOf('1.0.0-rc.10'));
  assert.equal(order.at(-1), '1.0.0');
});

// ── Build metadata ordering ──────────────────────────────────────────────────

test('build metadata +1 < +2 (numeric-aware tie-breaker)', () => {
  // Regression: lexicographic +10 < +2 (wrong), numeric: +2 < +10 (correct)
  assert.equal(compareVersions('1.0.0+1', '1.0.0+2'), -1);
  assert.equal(compareVersions('1.0.0+2', '1.0.0+1'), 1);
});

test('build metadata numeric ordering: +1 < +2 < +10 (reversed input)', () => {
  const expected = ['1.0.0+1', '1.0.0+2', '1.0.0+10'];
  assertOrder(sorted(...expected), 'forward');
  assertOrder(sortedReversed(...expected), 'reversed');
});

test('build metadata containing hyphen: +build-1 < +build-2', () => {
  // "build-1" dot-splits to ["build-1"], single alphanumeric identifier → lexicographic
  // "build-1" < "build-2" lexicographically ✓
  assert.equal(compareVersions('1.0.0+build-1', '1.0.0+build-2'), -1);
  assert.equal(compareVersions('1.0.0+build-2', '1.0.0+build-1'), 1);
  // reversed input
  assertOrder(sortedReversed('1.0.0+build-1', '1.0.0+build-2'), 'reversed');
});

test('build metadata does NOT make a version a prerelease', () => {
  // "1.0.0+0" has no prerelease; "1.0.0-alpha" does
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0+0'), -1, 'prerelease < build-only');
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0+build-1', '1.0.0-alpha'), 1, 'build > prerelease');
});

test('0.2.7+0 canonical pub.dev ordering', () => {
  const order = sorted('0.2.7+0', '0.2.6', '0.2.8-beta');
  assert.equal(order[0], '0.2.6');
  assert.equal(order[1], '0.2.7+0');
  assert.equal(order[2], '0.2.8-beta');
  // reversed input
  assertOrder(sortedReversed('0.2.7+0', '0.2.6', '0.2.8-beta'), 'reversed');
});

// ── Mixed real pub.dev versions ───────────────────────────────────────────────

test('mixed real pub.dev versions (http package pattern)', () => {
  const versions = [
    '1.6.0', '0.12.0', '0.12.0-nullsafety.0', '1.0.0-rc.1',
    '0.11.3+3', '0.12.0+2', '0.13.0-nullsafety.0',
  ];
  const order = sorted(...versions);
  const iof = (v: string) => order.indexOf(v);

  assert.ok(iof('0.11.3+3') < iof('0.12.0-nullsafety.0'), '0.11.3+3 < 0.12.0-nullsafety.0');
  assert.ok(iof('0.12.0-nullsafety.0') < iof('0.12.0'), 'nullsafety prerelease < stable');
  assert.ok(iof('0.12.0') < iof('0.12.0+2'), '0.12.0 < 0.12.0+2');
  assert.ok(iof('0.13.0-nullsafety.0') < iof('1.0.0-rc.1'), '0.13.x prerelease < 1.0.0 prerelease');
  assert.ok(iof('1.0.0-rc.1') < iof('1.6.0'), 'prerelease < 1.6.0 stable');

  // reversed input gives same order
  assertOrder(sortedReversed(...versions), 'reversed');
});

test('rc.9/rc.10 regression — reversed input', () => {
  const fwd = sorted('1.0.0-rc.9', '1.0.0-rc.10', '1.0.0-rc.1', '1.0.0');
  const rev = sortedReversed('1.0.0-rc.9', '1.0.0-rc.10', '1.0.0-rc.1', '1.0.0');
  assertOrder(fwd, 'forward');
  assertOrder(rev, 'reversed');
  assert.ok(fwd.indexOf('1.0.0-rc.9') < fwd.indexOf('1.0.0-rc.10'));
  assert.ok(rev.indexOf('1.0.0-rc.9') < rev.indexOf('1.0.0-rc.10'));
});
