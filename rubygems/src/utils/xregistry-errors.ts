const SPEC_BASE = 'https://github.com/xregistry/spec/blob/main/core/spec.md';

export class ProblemDetailsError extends Error {
    public readonly type: string;
    public readonly title: string;
    public readonly status: number;
    public readonly instance: string;
    public readonly detail?: string;

    constructor(type: string, title: string, status: number, instance: string, detail?: string, extensions: Record<string, unknown> = {}) {
        super(detail ?? title);
        this.name = 'ProblemDetailsError';
        this.type = type;
        this.title = title;
        this.status = status;
        this.instance = instance;
        if (detail) {
            this.detail = detail;
        }
        Object.assign(this, extensions);
    }
}

export function entityNotFound(instance: string, entityType: string, id: string): ProblemDetailsError {
    return new ProblemDetailsError(
        `${SPEC_BASE}#entity_not_found`,
        `${entityType} not found`,
        404,
        instance,
        `The ${entityType} '${id}' was not found.`
    );
}

export function invalidData(instance: string, attribute: string, reason: string): ProblemDetailsError {
    return new ProblemDetailsError(
        `${SPEC_BASE}#invalid_data`,
        'Invalid request data',
        400,
        instance,
        `${attribute}: ${reason}`,
        { attribute }
    );
}

export function internalError(instance: string, detail?: string): ProblemDetailsError {
    return new ProblemDetailsError(
        `${SPEC_BASE}#internal_error`,
        'Internal Server Error',
        500,
        instance,
        detail
    );
}

export function serviceUnavailable(instance: string, detail?: string): ProblemDetailsError {
    return new ProblemDetailsError(
        `${SPEC_BASE}#service_unavailable`,
        'Service Unavailable',
        503,
        instance,
        detail
    );
}

export function errorToXRegistryError(error: unknown, instance: string): ProblemDetailsError {
    if (error instanceof ProblemDetailsError) {
        return error;
    }

    if (error instanceof Error) {
        if (error.message.toLowerCase().includes('not found')) {
            return entityNotFound(instance, 'resource', 'unknown');
        }
        return internalError(instance, error.message);
    }

    return internalError(instance, 'An unexpected error occurred.');
}
