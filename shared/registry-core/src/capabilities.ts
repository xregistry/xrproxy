/** xRegistry 1.0-rc2 capability-map construction. */

export const XREGISTRY_RC2_SPEC_VERSION = "1.0-rc2" as const;
export const XREGISTRY_RC2_JSON_SCHEMA = "xRegistry-json/1.0-rc2" as const;

export const XREGISTRY_RC2_FLAGS = [
  "collections",
  "doc",
  "epoch",
  "filter",
  "inline",
  "nodefaultversionid",
  "nodefaultversionsticky",
  "noepoch",
  "noreadonly",
  "offered",
  "schema",
  "setdefaultversionid",
  "sort",
  "specversion",
] as const;

export type XRegistryFlag = typeof XREGISTRY_RC2_FLAGS[number];
export type XRegistryMutableTarget = "capabilities" | "entities" | "modelsource";
export type XRegistryVersionMode = "manual" | "createdat" | "modifiedat" | "semver";

export interface RegistryCapabilitiesOptions {
  readonly apis?: readonly string[];
  readonly flags?: readonly XRegistryFlag[];
  readonly mutable?: readonly XRegistryMutableTarget[];
  readonly pagination?: boolean;
  readonly schemas?: readonly string[];
  readonly shortself?: boolean;
  readonly specversions?: readonly string[];
  readonly sticky?: boolean;
  readonly versionmodes?: readonly XRegistryVersionMode[];
}

export interface RegistryCapabilities {
  readonly apis: readonly string[];
  readonly flags: readonly XRegistryFlag[];
  readonly mutable: readonly XRegistryMutableTarget[];
  readonly pagination: boolean;
  readonly schemas: readonly string[];
  readonly shortself: boolean;
  readonly specversions: readonly string[];
  readonly sticky: boolean;
  readonly versionmodes: readonly XRegistryVersionMode[];
}

function unique<T>(values: readonly T[], name: string): readonly T[] {
  const result = [...new Set(values)];
  if (result.length !== values.length) {
    throw new TypeError(name + " capability values must be unique");
  }
  return Object.freeze(result);
}

/**
 * Build a complete xRegistry 1.0-rc2 capability map.
 *
 * Core spec section Registry Capabilities requires known capabilities to be
 * serialized even when false or empty. Callers opt in only to flags and APIs
 * that their runtime actually implements.
 */
export function createRegistryCapabilities(
  options: RegistryCapabilitiesOptions = {},
): RegistryCapabilities {
  const apis = unique(options.apis ?? ["/capabilities", "/model", "/modelsource"], "apis");
  if (apis.some(api => !api.startsWith("/"))) {
    throw new TypeError("apis capability values must start with /");
  }

  const schemas = unique(options.schemas ?? [XREGISTRY_RC2_JSON_SCHEMA], "schemas");
  if (!schemas.some(schema => schema.toLowerCase() === XREGISTRY_RC2_JSON_SCHEMA.toLowerCase())) {
    throw new TypeError("schemas must include " + XREGISTRY_RC2_JSON_SCHEMA);
  }

  const specversions = unique(options.specversions ?? [XREGISTRY_RC2_SPEC_VERSION], "specversions");
  if (!specversions.some(version => version.toLowerCase() === XREGISTRY_RC2_SPEC_VERSION)) {
    throw new TypeError("specversions must include " + XREGISTRY_RC2_SPEC_VERSION);
  }

  const versionmodes = unique(options.versionmodes ?? ["manual"], "versionmodes");
  if (!versionmodes.includes("manual")) {
    throw new TypeError("versionmodes must include manual");
  }

  return Object.freeze({
    apis,
    flags: unique(options.flags ?? [], "flags") as readonly XRegistryFlag[],
    mutable: unique(options.mutable ?? [], "mutable") as readonly XRegistryMutableTarget[],
    pagination: options.pagination ?? true,
    schemas,
    shortself: options.shortself ?? false,
    specversions,
    sticky: options.sticky ?? false,
    versionmodes: versionmodes as readonly XRegistryVersionMode[],
  });
}
