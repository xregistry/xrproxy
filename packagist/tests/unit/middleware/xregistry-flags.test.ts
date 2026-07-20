import { applyFilter, getNamePrefixFilter } from '../../../src/middleware/xregistry-flags';

describe('xRegistry package filters', () => {
    test('extracts a name prefix that can be sent to Packagist search', () => {
        expect(getNamePrefixFilter([['name=symfony/*']])).toBe('symfony/');
    });

    test('keeps non-wildcard filters exact on the requested field', () => {
        const groups = [{ name: 'symfony' }, { name: 'friendsofsymfony' }];
        expect(applyFilter(groups, [['name=symfony']])).toEqual([{ name: 'symfony' }]);
    });

    test('applies trailing-star filters as prefixes', () => {
        const packages = [
            { name: 'symfony/console' },
            { name: 'symfony/http-foundation' },
            { name: 'laravel/framework' },
        ];

        expect(applyFilter(packages, [['name=symfony/*']])).toEqual([
            { name: 'symfony/console' },
            { name: 'symfony/http-foundation' },
        ]);
    });
});
