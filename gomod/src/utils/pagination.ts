export function buildPaginationLinkHeader(
    collectionUrl: string,
    offset: number,
    limit: number,
    totalCount: number,
    extraParams: Record<string, string | undefined> = {}
): string | undefined {
    if (totalCount <= limit && offset === 0) return undefined;

    const links: string[] = [];
    const addLink = (targetOffset: number, relation: string): void => {
        const query = new URLSearchParams({
            offset: String(targetOffset),
            limit: String(limit),
        });
        for (const [name, value] of Object.entries(extraParams)) {
            if (value !== undefined) query.set(name, value);
        }
        links.push(`<${collectionUrl}?${query}>; rel="${relation}"`);
    };

    const lastOffset = totalCount > 0
        ? Math.floor((totalCount - 1) / limit) * limit
        : 0;

    if (offset > 0) {
        addLink(0, 'first');
        addLink(Math.max(0, offset - limit), 'prev');
    }
    if (offset + limit < totalCount) {
        addLink(offset + limit, 'next');
        addLink(lastOffset, 'last');
    }

    return links.length > 0 ? links.join(', ') : undefined;
}
