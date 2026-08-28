import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import { SmokeSchemaError } from "./errors.js";

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

export interface SmokeSchemaSet {
  readonly report: unknown;
  readonly aggregate: unknown;
}

export interface SmokeSchemaValidator {
  readonly validateSmokeReport: (value: unknown) => SchemaValidationResult;
  readonly validateSmokeAggregate: (value: unknown) => SchemaValidationResult;
  readonly assertValidSmokeReport: (value: unknown) => asserts value is Record<string, unknown>;
  readonly assertValidSmokeAggregate: (value: unknown) => asserts value is Record<string, unknown>;
}

export interface SmokeReportSchemaValidator {
  readonly validateSmokeReport: (value: unknown) => SchemaValidationResult;
  readonly assertValidSmokeReport: (value: unknown) => asserts value is Record<string, unknown>;
}

function compile(schema: unknown): ValidateFunction<unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new SmokeSchemaError("A JSON schema object is required.");
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile<unknown>(schema);
}

function result(validator: ValidateFunction<unknown>, value: unknown): SchemaValidationResult {
  const valid = validator(value);
  return { valid, errors: validator.errors == null ? [] : [...validator.errors] };
}

export function createSmokeSchemaValidator(schemas: SmokeSchemaSet): SmokeSchemaValidator {
  const reportValidator = compile(schemas.report);
  const aggregateValidator = compile(schemas.aggregate);
  const validateSmokeReport = (value: unknown): SchemaValidationResult => result(reportValidator, value);
  const validateSmokeAggregate = (value: unknown): SchemaValidationResult => result(aggregateValidator, value);
  const assertValidSmokeReport = (value: unknown): asserts value is Record<string, unknown> => {
    const validation = validateSmokeReport(value);
    if (!validation.valid) {
      throw new SmokeSchemaError("Smoke report does not satisfy smoke-report-v1.", validation.errors);
    }
  };
  const assertValidSmokeAggregate = (value: unknown): asserts value is Record<string, unknown> => {
    const validation = validateSmokeAggregate(value);
    if (!validation.valid) {
      throw new SmokeSchemaError("Smoke aggregate does not satisfy smoke-aggregate-v1.", validation.errors);
    }
  };
  return { validateSmokeReport, validateSmokeAggregate, assertValidSmokeReport, assertValidSmokeAggregate };
}

export function createSmokeReportSchemaValidator(reportSchema: unknown): SmokeReportSchemaValidator {
  const reportValidator = compile(reportSchema);
  const validateSmokeReport = (value: unknown): SchemaValidationResult => result(reportValidator, value);
  const assertValidSmokeReport = (value: unknown): asserts value is Record<string, unknown> => {
    const validation = validateSmokeReport(value);
    if (!validation.valid) {
      throw new SmokeSchemaError("Smoke report does not satisfy smoke-report-v1.", validation.errors);
    }
  };
  return { validateSmokeReport, assertValidSmokeReport };
}
