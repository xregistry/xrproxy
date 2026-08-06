export function parseFilterParams(filter: unknown): Record<string, string> {
    if (!filter) {
        return {};
    }

    if (typeof filter === 'string') {
        const parts = filter.split('=');
        if (parts.length === 2 && parts[0]) {
            return { [parts[0]]: parts[1] || '' };
        }
    }

    return {};
}

export function parsePaginationParams(
    query: Record<string, unknown>,
    defaultLimit: number = 50
): { offset: number; limit: number } {
    const parsedLimit = parseInt(String(query['limit'] ?? defaultLimit), 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : defaultLimit;

    const parsedOffset = parseInt(String(query['offset'] ?? ''), 10);
    if (Number.isFinite(parsedOffset) && parsedOffset >= 0) {
        return { offset: parsedOffset, limit };
    }

    const parsedPage = parseInt(String(query['page'] ?? 1), 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    return {
        offset: Math.max(0, (page - 1) * limit),
        limit,
    };
}
