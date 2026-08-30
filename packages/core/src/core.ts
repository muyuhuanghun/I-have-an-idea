import type { CorePorts } from "./ports.js";

/** Version of the current shared-core surface. */
export const CORE_VERSION = "phase3a-recovery-file-v1";

export interface Core {
  readonly version: typeof CORE_VERSION;
  readonly ports: CorePorts;
}

/**
 * Wire ports into the shared core without performing a snapshot operation.
 * Snapshot orchestration, Manifest/Object encryption, Object codecs, and ObjectStore behavior remain absent.
 */
export function createCore(ports: CorePorts): Core {
  return Object.freeze({
    version: CORE_VERSION,
    ports
  });
}
