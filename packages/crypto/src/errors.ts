/** Stable error for the intentionally unconfigured Phase 1 provider boundary. */
export class CryptoProviderUnavailableError extends Error {
  readonly code = "CRYPTO_PROVIDER_UNAVAILABLE" as const;

  constructor() {
    super("No crypto candidate is configured; complete the Phase 1 smoke gate first.");
    this.name = "CryptoProviderUnavailableError";
  }
}

export type CryptoPrimitiveErrorCode =
  | "CRYPTO_INPUT_INVALID"
  | "OBJECT_AEAD_FAILED"
  | "OBJECT_KEY_UNWRAP_FAILED"
  | "RANDOM_SOURCE_ALL_ZERO"
  | "RANDOM_SOURCE_FAILED"
  | "RANDOM_SOURCE_SHORT_READ";

/** Stable smoke-harness error; the cause stays diagnostic and never becomes an oracle. */
export class CryptoPrimitiveError extends Error {
  constructor(
    readonly code: CryptoPrimitiveErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CryptoPrimitiveError";
  }
}
