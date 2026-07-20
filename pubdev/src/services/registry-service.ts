/**
 * Registry Service — root, groups, model endpoints
 */

import { EntityStateManager } from '../../../shared/entity-state-manager';
import { CAPABILITIES, MODEL, REGISTRY_METADATA } from '../config/constants';
import { SearchService } from './search-service';

const { REGISTRY_ID, GROUP_TYPE, GROUP_ID, GROUP_TYPE_SINGULAR, RESOURCE_TYPE, SPEC_VERSION } = REGISTRY_METADATA;

export class RegistryService {
  constructor(
    private readonly search: SearchService,
    private readonly entityState: EntityStateManager,
  ) {}

  getRoot(baseUrl: string): Record<string, unknown> {
    return {
      specversion:  SPEC_VERSION,
      registryid:   REGISTRY_ID,
      xid:          '/',
      self:         `${baseUrl}/`,
      description:  'xRegistry-compliant read-only proxy for the pub.dev Dart/Flutter package registry.',
      documentation: `${baseUrl}/model`,
      capabilities:  CAPABILITIES,
      [`${GROUP_TYPE}url`]:   `${baseUrl}/${GROUP_TYPE}`,
      [`${GROUP_TYPE}count`]: 1,
      epoch:      this.entityState.getEpoch('/'),
      createdat:  this.entityState.getCreatedAt('/'),
      modifiedat: this.entityState.getModifiedAt('/'),
    };
  }

  getModel(baseUrl: string): Record<string, unknown> {
    return { ...(MODEL as Record<string, unknown>), self: `${baseUrl}/model` };
  }

  getCapabilities(): typeof CAPABILITIES { return CAPABILITIES; }

  getGroups(baseUrl: string): Record<string, unknown> {
    const groupPath = `/${GROUP_TYPE}/${GROUP_ID}`;
    const count = this.search.isAuthoritative() ? this.search.getAll().length : undefined;
    return {
      [GROUP_ID]: {
        [`${GROUP_TYPE_SINGULAR}id`]: GROUP_ID,
        xid:        groupPath,
        name:       GROUP_ID,
        description: 'pub.dev — the official Dart/Flutter package registry',
        epoch:      this.entityState.getEpoch(groupPath),
        createdat:  this.entityState.getCreatedAt(groupPath),
        modifiedat: this.entityState.getModifiedAt(groupPath),
        self:       `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}`,
        [`${RESOURCE_TYPE}url`]: `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}`,
        ...(count !== undefined ? { [`${RESOURCE_TYPE}count`]: count } : {}),
      },
    };
  }

  getGroupDetails(baseUrl: string): Record<string, unknown> {
    const groupPath = `/${GROUP_TYPE}/${GROUP_ID}`;
    const count = this.search.isAuthoritative() ? this.search.getAll().length : undefined;
    return {
      [`${GROUP_TYPE_SINGULAR}id`]: GROUP_ID,
      xid:        groupPath,
      name:       GROUP_ID,
      description: 'pub.dev — the official Dart/Flutter package registry',
      epoch:      this.entityState.getEpoch(groupPath),
      createdat:  this.entityState.getCreatedAt(groupPath),
      modifiedat: this.entityState.getModifiedAt(groupPath),
      self:       `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}`,
      [`${RESOURCE_TYPE}url`]: `${baseUrl}/${GROUP_TYPE}/${GROUP_ID}/${RESOURCE_TYPE}`,
      ...(count !== undefined ? { [`${RESOURCE_TYPE}count`]: count } : {}),
    };
  }
}
