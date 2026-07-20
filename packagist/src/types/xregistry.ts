/**
 * xRegistry entity type definitions for the Packagist wrapper.
 * Based on xRegistry specification 1.0-rc2.
 */

export interface XRegistryEntity {
    xid: string;
    name?: string;
    description?: string;
    epoch: number;
    createdat: string;
    modifiedat: string;
    labels?: Record<string, string>;
    documentation?: string;
    self: string;
    [key: string]: unknown;
}

export interface XRegistryVersion extends XRegistryEntity {
    versionid: string;
    packageid: string;
    isdefault: boolean;
    ancestor: string;
    /** True for stable tagged releases; false for mutable dev-* aliases. */
    immutable: boolean;
    /** The human-readable version string as declared in composer.json. */
    version: string;
    /** The Composer-normalized version string. */
    versionnormalized?: string;
    /** VCS reference (commit SHA or branch). Critical for dev-* identity. */
    sourcereference?: string;
}

export interface XRegistryResource extends XRegistryEntity {
    packageid: string;
    versionid?: string;
    isdefault?: boolean;
    versionsurl?: string;
    versionscount?: number;
}
