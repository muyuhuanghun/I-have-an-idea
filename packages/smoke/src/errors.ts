export class SmokeContractError extends Error {
  readonly code = "SMOKE_CONTRACT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "SmokeContractError";
  }
}

export class SmokeSchemaError extends Error {
  readonly code = "REPORT_SCHEMA_INVALID" as const;

  readonly details: readonly unknown[];

  constructor(message: string, details: readonly unknown[] = []) {
    super(message);
    this.name = "SmokeSchemaError";
    this.details = details;
  }
}

export class SmokeAggregateError extends Error {
  readonly code = "SMOKE_AGGREGATE_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "SmokeAggregateError";
  }
}

