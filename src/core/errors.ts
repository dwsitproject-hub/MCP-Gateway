/**
 * Typed error taxonomy (TSD Section 10 error-handling matrix).
 *
 * Rules:
 *  - Tool errors returned to the model carry { code, message, retryable } only.
 *  - Never a stack trace, never a raw KLIP error body (they leak internals).
 */

export type ErrorCode =
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'UNKNOWN_FILTER_VALUE'
  | 'UPSTREAM_AUTH'
  | 'UPSTREAM_UNAVAILABLE'
  | 'GUARD_BLOCK'
  | 'RATE_LIMITED'
  | 'AUDIT_UNAVAILABLE'
  | 'INTERNAL';

export interface ToolErrorShape {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** Optional structured hint. Must never contain upstream payloads or credentials. */
  detail?: Record<string, unknown>;
}

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown> | undefined;
  /** high severity errors are audited as incidents and should page the owner. */
  readonly severity: 'low' | 'high';

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; detail?: Record<string, unknown>; severity?: 'low' | 'high' } = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail;
    this.severity = opts.severity ?? 'low';
  }

  toToolError(): ToolErrorShape {
    const shape: ToolErrorShape = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.detail !== undefined) shape.detail = this.detail;
    return shape;
  }
}

/**
 * Raised by the adapter HTTP client when a request violates the method/path allowlist (T-6).
 * This is layer (b) of the S1 defense-in-depth and indicates a coding defect or tampering.
 */
export class GuardError extends GatewayError {
  constructor(method: string, path: string) {
    super('GUARD_BLOCK', `Blocked by adapter method guard: ${method} ${path}`, {
      retryable: false,
      detail: { method, path },
      severity: 'high',
    });
    this.name = 'GuardError';
  }
}

export const invalidParams = (message: string, detail?: Record<string, unknown>): GatewayError =>
  new GatewayError('INVALID_PARAMS', message, detail === undefined ? {} : { detail });

export const notFound = (what: string): GatewayError =>
  new GatewayError('NOT_FOUND', `${what} was not found in KLIP.`);

export const unknownFilterValue = (
  field: string,
  supplied: string,
  didYouMean: string[],
): GatewayError =>
  new GatewayError(
    'UNKNOWN_FILTER_VALUE',
    `No KLIP ${field} matches "${supplied}". This is not an empty result - the filter value itself is unrecognised.`,
    { detail: { field, supplied, did_you_mean: didYouMean } },
  );

export const upstreamAuth = (): GatewayError =>
  new GatewayError('UPSTREAM_AUTH', 'The KLIP data source rejected the gateway service account. Data is temporarily unavailable.', {
    retryable: false,
    severity: 'high',
  });

export const upstreamUnavailable = (why: string): GatewayError =>
  new GatewayError('UPSTREAM_UNAVAILABLE', `The KLIP data source is not responding (${why}).`, { retryable: true });

export const rateLimited = (retryAfterSeconds: number): GatewayError =>
  new GatewayError('RATE_LIMITED', `Rate limit exceeded. Retry in ${retryAfterSeconds}s.`, {
    retryable: true,
    detail: { retry_after_seconds: retryAfterSeconds },
  });

/** Audit store unavailable. Fail closed: no tool call proceeds unattributable (review H9.4). */
export const auditUnavailable = (): GatewayError =>
  new GatewayError('AUDIT_UNAVAILABLE', 'The audit store is unavailable, so this request cannot be recorded and was refused.', {
    retryable: true,
    severity: 'high',
  });

export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  return new GatewayError('INTERNAL', 'An internal gateway error occurred.', { retryable: false });
}
