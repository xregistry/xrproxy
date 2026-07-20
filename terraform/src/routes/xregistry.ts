/** xRegistry root, namespace groups, export and legacy path migration. */

import { NextFunction, Request, Response, Router } from 'express';
import {
    decodeLegacyModuleId,
    decodeLegacyProviderId,
    getBaseUrl,
    isTerraformIdentifier,
    REGISTRY_METADATA,
} from '../config/constants';
import { RegistryService } from '../services/registry-service';
import { parsePagination, setPaginationHeaders } from '../utils/collection';

function decodedSegments(req: Request): string[] | null {
    try {
        return req.originalUrl.split('?', 1)[0]!.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
    } catch {
        return null;
    }
}

function migrationResponse(req: Request, res: Response, segments: readonly string[]): void {
    const { GROUP_TYPE, MODULE_RESOURCE_TYPE, PROVIDER_RESOURCE_TYPE } = REGISTRY_METADATA;
    const resourceType = segments[2] === MODULE_RESOURCE_TYPE
        ? MODULE_RESOURCE_TYPE
        : segments[2] === PROVIDER_RESOURCE_TYPE
            ? PROVIDER_RESOURCE_TYPE
            : '{providers|modules}';
    const legacyId = segments[3];
    const suffix = segments.slice(4).map(segment => `/${encodeURIComponent(segment)}`).join('');
    let replacement = `/${GROUP_TYPE}/{namespace}/${resourceType}/{resource}${suffix}`;
    if (resourceType === PROVIDER_RESOURCE_TYPE && legacyId) {
        const decoded = decodeLegacyProviderId(legacyId);
        if (decoded) replacement = `/${GROUP_TYPE}/${decoded.namespace}/${resourceType}/${decoded.type}${suffix}`;
    } else if (resourceType === MODULE_RESOURCE_TYPE && legacyId) {
        const decoded = decodeLegacyModuleId(legacyId);
        if (decoded) replacement = `/${GROUP_TYPE}/${decoded.namespace}/${resourceType}/${decoded.name}~${decoded.provider}${suffix}`;
    }
    res.status(410).json({
        type: 'https://github.com/xregistry/xrproxy/issues/203',
        title: 'Terraform path migrated',
        status: 410,
        instance: req.originalUrl,
        detail: 'The fixed registry.terraform.io group and namespace-bearing resource IDs were removed.',
        replacement,
    });
}

export function createXRegistryRoutes(registryService: RegistryService): Router {
    const router = Router();
    const { GROUP_TYPE, LEGACY_GROUP_ID, GROUP_TYPE_SINGULAR } = REGISTRY_METADATA;

    router.use((req, res, next) => {
        const segments = decodedSegments(req);
        if (!segments) {
            res.status(400).json({ type: 'about:blank', title: 'Malformed URL encoding', status: 400, instance: req.originalUrl });
            return;
        }
        if (
            segments[0] === GROUP_TYPE &&
            segments[1]?.toLowerCase() === LEGACY_GROUP_ID &&
            segments[1] !== LEGACY_GROUP_ID
        ) {
            res.status(404).json({ type: 'about:blank', title: 'Not Found', status: 404, instance: req.originalUrl });
            return;
        }
        if (segments[0] === GROUP_TYPE && segments[1] === LEGACY_GROUP_ID) {
            migrationResponse(req, res, segments);
            return;
        }
        next();
    });

    router.get('/', (req: Request, res: Response) => {
        res.json(registryService.getRoot(getBaseUrl(req)));
    });


    router.get(`/${GROUP_TYPE}`, (req: Request, res: Response) => {
        if (req.query['filter'] !== undefined || req.query['sort'] !== undefined) {
            res.status(400).json({
                type: 'about:blank',
                title: 'Unsupported collection operation',
                status: 400,
                detail: 'Terraform discovery snapshots do not support filter or sort.',
                instance: req.originalUrl,
            });
            return;
        }
        const { offset, limit } = parsePagination(req);
        const ordered = registryService.getNamespaces().map(summary =>
            registryService.getGroup(getBaseUrl(req), summary),
        );
        const body: Record<string, unknown> = {};
        for (const entity of ordered.slice(offset, offset + limit)) {
            body[String(entity[`${GROUP_TYPE_SINGULAR}id`])] = entity;
        }
        setPaginationHeaders(req, res, offset, limit, ordered.length, false);
        res.json(body);
    });

    router.get(`/${GROUP_TYPE}/:groupId`, async (req: Request, res: Response, next: NextFunction) => {
        const groupId = String(req.params['groupId'] ?? '');
        if (!isTerraformIdentifier(groupId)) {
            res.status(400).json({
                type: 'about:blank',
                title: 'Invalid Terraform namespace',
                status: 400,
                instance: req.originalUrl,
            });
            return;
        }
        try {
            const summary = await registryService.resolveNamespace(groupId);
            // xRegistry IDs are case-sensitive even though Terraform discovery
            // and upstream resolution are canonicalized case-insensitively.
            if (!summary || summary.namespace !== groupId) {
                res.status(404).json({
                    type: 'https://github.com/xregistry/spec/blob/v1.0-rc2/core/spec.md#entity_not_found',
                    title: 'Terraform namespace not found',
                    status: 404,
                    instance: req.originalUrl,
                });
                return;
            }
            res.setHeader('X-Collection-Complete', 'false');
            res.setHeader('Warning', '299 - "Terraform namespace discovery is incomplete"');
            // EntityStateManager is touched only after existence and canonical
            // case have been established.
            res.json(registryService.getGroup(getBaseUrl(req), summary));
        } catch (error) {
            next(error);
        }
    });

    return router;
}
