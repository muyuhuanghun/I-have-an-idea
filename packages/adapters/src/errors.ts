/** Stable error used by adapter placeholders before a Phase 1 implementation is authorized. */
export class AdapterNotImplementedError extends Error {
  readonly code = "ADAPTER_NOT_IMPLEMENTED" as const;

  constructor(adapterName: string) {
    super(`${adapterName} is a Phase 1 scaffold; its I/O implementation is not enabled yet.`);
    this.name = "AdapterNotImplementedError";
  }
}
