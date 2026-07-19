import { buildPaginationLinkHeader } from '../src/utils/pagination';

describe('Go collection pagination links', () => {
    const url = 'https://registry.example.test/goregistries';

    it('emits next and last on the first page', () => {
        expect(buildPaginationLinkHeader(url, 0, 50, 215)).toBe(
            `<${url}?offset=50&limit=50>; rel="next", ` +
            `<${url}?offset=200&limit=50>; rel="last"`
        );
    });

    it('emits all navigation relations on a middle page and preserves filters', () => {
        const header = buildPaginationLinkHeader(url, 50, 50, 215, {
            filter: 'goregistryid=github.*',
        });

        expect(header).toContain(`offset=0&limit=50&filter=goregistryid%3Dgithub.*>; rel="first"`);
        expect(header).toContain(`offset=0&limit=50&filter=goregistryid%3Dgithub.*>; rel="prev"`);
        expect(header).toContain(`offset=100&limit=50&filter=goregistryid%3Dgithub.*>; rel="next"`);
        expect(header).toContain(`offset=200&limit=50&filter=goregistryid%3Dgithub.*>; rel="last"`);
    });

    it('emits first and previous on the last page', () => {
        expect(buildPaginationLinkHeader(url, 200, 50, 215)).toBe(
            `<${url}?offset=0&limit=50>; rel="first", ` +
            `<${url}?offset=150&limit=50>; rel="prev"`
        );
    });
});
