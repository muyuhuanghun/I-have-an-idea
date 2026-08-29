import type { CorePorts } from "./ports.js";

/** Version of the Phase 2 shared-core surface. */
export const CORE_VERSION = "phase2-scanner-manifest-v1";

export interface Core {
  readonly version: typeof CORE_VERSION;
  readonly ports: CorePorts;
}

/**
 * Wire ports into the shared core without performing a snapshot operation.
 * Recovery, encryption, Object codecs, and ObjectStore orchestration remain absent.
 */
export function createCore(ports: CorePorts): Core {
  return Object.freeze({
    version: CORE_VERSION,
    ports
  });
}
