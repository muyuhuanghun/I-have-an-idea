import type { CorePorts } from "./ports.js";

/** Version of the intentionally non-protocol Phase 1 wiring surface. */
export const CORE_VERSION = "phase1-scaffold-v1";

export interface Core {
  readonly version: typeof CORE_VERSION;
  readonly ports: CorePorts;
}

/**
 * Wire ports into the shared core without performing a snapshot operation.
 * Recovery, Manifest, and Object codec behavior are not part of this scaffold.
 */
export function createCore(ports: CorePorts): Core {
  return Object.freeze({
    version: CORE_VERSION,
    ports
  });
}
