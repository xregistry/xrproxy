import { createHash } from 'crypto';

const HASHED_IMAGE_ID_PREFIX = 'xh~';

export function canonicalizeRegistryId(registryId: string): string {
    const normalized = registryId.trim().toLowerCase();
    if (normalized === 'index.docker.io') {
        return 'docker.io';
    }
    return normalized;
}

export function getSourceApiUrl(registryUrl: string): string {
    return `${registryUrl.replace(/\/+$/, '')}/v2/`;
}

export function getNamespaceFromRepository(repository: string): string | undefined {
    const slashIndex = repository.indexOf('/');
    if (slashIndex <= 0) {
        return undefined;
    }
    return repository.slice(0, slashIndex);
}

export function repositoryNameFromImageId(imageId: string): string | undefined {
    if (!imageId || imageId.startsWith(HASHED_IMAGE_ID_PREFIX)) {
        return undefined;
    }
    return imageId.replace(/~/g, '/');
}

export function toImageId(repository: string): string {
    const normalizedRepository = repository.trim();
    const directId = normalizedRepository.replace(/\//g, '~');

    if (!directId.startsWith(HASHED_IMAGE_ID_PREFIX) && directId.length <= 128) {
        return directId;
    }

    const digest = createHash('sha256').update(normalizedRepository, 'utf8').digest('hex');
    return `${HASHED_IMAGE_ID_PREFIX}${digest}`;
}

export function matchesImageId(repository: string, imageId: string): boolean {
    return toImageId(repository) === imageId;
}
