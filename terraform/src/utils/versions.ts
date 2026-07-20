/** Deterministic Terraform version ordering independent of upstream array order. */

interface ParsedSemVer {
    major: bigint;
    minor: bigint;
    patch: bigint;
    prerelease: string[];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemVer(value: string): ParsedSemVer | null {
    const match = SEMVER.exec(value);
    if (!match) return null;
    const prerelease = match[4]?.split('.') ?? [];
    if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
    return {
        major: BigInt(match[1]!),
        minor: BigInt(match[2]!),
        patch: BigInt(match[3]!),
        prerelease,
    };
}

function compareIdentifier(a: string, b: string): number {
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
        const av = BigInt(a);
        const bv = BigInt(b);
        return av < bv ? -1 : av > bv ? 1 : 0;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareParsed(a: ParsedSemVer, b: ParsedSemVer): number {
    for (const key of ['major', 'minor', 'patch'] as const) {
        if (a[key] < b[key]) return -1;
        if (a[key] > b[key]) return 1;
    }
    if (a.prerelease.length === 0 || b.prerelease.length === 0) {
        return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
    }
    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let i = 0; i < length; i += 1) {
        if (a.prerelease[i] === undefined) return -1;
        if (b.prerelease[i] === undefined) return 1;
        const compared = compareIdentifier(a.prerelease[i]!, b.prerelease[i]!);
        if (compared !== 0) return compared;
    }
    return 0;
}

/**
 * Ascending order. Strict SemVer values sort by SemVer precedence. Invalid
 * values sort lexically before valid SemVer values, so a valid release wins
 * default-version selection whenever one exists. Build metadata is a stable
 * lexical tie-breaker only; it does not change SemVer precedence.
 */
export function compareTerraformVersions(a: string, b: string): number {
    const parsedA = parseSemVer(a);
    const parsedB = parseSemVer(b);
    if (parsedA && parsedB) {
        const precedence = compareParsed(parsedA, parsedB);
        if (precedence !== 0) return precedence;
    } else if (parsedA || parsedB) {
        return parsedA ? 1 : -1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

export function sortTerraformVersions(values: readonly string[]): string[] {
    return [...new Set(values)].sort(compareTerraformVersions);
}

export function sortTerraformVersionObjects<T extends { version: string }>(values: readonly T[]): T[] {
    const unique = new Map<string, T>();
    for (const value of values) if (!unique.has(value.version)) unique.set(value.version, value);
    return [...unique.values()].sort((a, b) => compareTerraformVersions(a.version, b.version));
}

export function predecessorOf(ordered: readonly string[], version: string): string {
    const index = ordered.indexOf(version);
    return index > 0 ? ordered[index - 1]! : version;
}
