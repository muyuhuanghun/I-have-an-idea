import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmokeSchemaValidator, type SmokeSchemaValidator } from "./schema.js";
import { SmokeSchemaError } from "./errors.js";

function schemaPath(fileName: string): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "docs/schemas", fileName),
    resolve(process.cwd(), "../../docs/schemas", fileName),
    resolve(moduleDirectory, "../../../docs/schemas", fileName),
    resolve(moduleDirectory, "../../docs/schemas", fileName)
  ];
  const result = candidates.find((candidate) => existsSync(candidate));
  if (result === undefined) {
    throw new SmokeSchemaError(`Unable to locate ${fileName}.`);
  }
  return result;
}

export function loadSmokeSchemaValidator(options: { readonly report_path?: string; readonly aggregate_path?: string } = {}): SmokeSchemaValidator {
  const report = JSON.parse(readFileSync(options.report_path ?? schemaPath("smoke-report-v1.schema.json"), "utf8")) as unknown;
  const aggregate = JSON.parse(readFileSync(options.aggregate_path ?? schemaPath("smoke-aggregate-v1.schema.json"), "utf8")) as unknown;
  return createSmokeSchemaValidator({ report, aggregate });
}

