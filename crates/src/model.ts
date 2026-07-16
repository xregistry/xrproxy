import modelData from '../model.json';

export const MODEL = modelData;

export const CAPABILITIES = {
  schemas: [
    'https://xregistry.io/specification/registry/model',
    'https://xregistry.io/specification/rust/crate'
  ],
  pagination: {
    style: 'offset',
    defaultPageSize: 25,
    maxPageSize: 100
  },
  filtering: {
    fields: ['name', 'description', 'keywords', 'categories']
  }
};

export const REGISTRY_ID = 'crates.io';
export const REGISTRY_NAME = 'crates.io';
export const GROUP_TYPE = 'rustregistries';
export const GROUP_TYPE_SINGULAR = 'rustregistry';
export const RESOURCE_TYPE = 'crates';
export const RESOURCE_TYPE_SINGULAR = 'crate';
export const SPEC_VERSION = '1.0-rc2';
export const SCHEMA_VERSION = 'xRegistry-json/1.0-rc2';
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
