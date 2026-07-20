import { createRegistryCapabilities } from "@xregistry/registry-core";

/** Runtime features implemented by the Hugging Face read-only proxy. */
export const CAPABILITIES = createRegistryCapabilities({
  flags: ["filter"],
  versionmodes: ["manual"],
});
