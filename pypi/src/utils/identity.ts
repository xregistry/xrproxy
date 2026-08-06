import { REGISTRY_METADATA } from '../config/constants';

export function normalizePackageId(packageName: string): string {
    return packageName.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

export function toVersionId(version: string): string {
    return version.replace(/\+/g, '~');
}

export function buildPackagePath(packageId: string): string {
    const { GROUP_TYPE, GROUP_ID, RESOURCE_TYPE } = REGISTRY_METADATA;
    return `/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}/${packageId}`;
}

export function buildVersionPath(packageId: string, versionId: string): string {
    return `${buildPackagePath(packageId)}/versions/${versionId}`;
}

export function buildPackageXid(packageId: string): string {
    return buildPackagePath(packageId);
}

export function extractDependencyPackageId(specifier: string): string | undefined {
    const trimmed = specifier.trim();
    const match = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (!match || !match[1]) {
        return undefined;
    }

    return normalizePackageId(match[1]);
}
