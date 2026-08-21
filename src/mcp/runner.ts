/**
 * The single call path every tool takes (TSD Figure 3).
 *
 *   rate limit -> audit(tool_request) -> handler -> wrap -> audit(tool_outcome)
 *
 * Enforced here rather than left to each tool, so a new tool cannot forget to
 * audit itself. Failures are audited too: S4 requires 100% of calls, success and
 * failure, to be recorded.
 *
 * The audit(tool_request) write happens BEFORE any KLIP call and fails closed - if
 * the call cannot be attributed, it does not happen (review H9.4).
 */
import * as audit from './../core/audit.js';
import * as rateLimit from './../core/rateLimit.js';
import { GatewayError, GuardError, rateLimited, toGatewayError } from './../core/errors.js';
import { logger } from './../core/logger.js';
import { errorResult, successResult, wrap, type ToolResult } from './envelope.js';
import type { InputShape, ToolContext, ToolDefinition } from './../tools/klip/types.js';

export async function runTool(
  def: ToolDefinition<InputShape>,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const started = Date.now();

  // --- per-user rate limit (keyed on the OAuth subject, not the IP) -------
  const decision = rateLimit.check(ctx.userId);
  if (!decision.allowed) {
    const err = rateLimited(decision.retryAfterSeconds);
    await audit
      .write({ event: 'tool_outcome', ctx, tool: def.name, outcome: 'RATE_LIMITED', latencyMs: 0 })
      .catch(() => undefined);
    return errorResult(def.name, err.toToolError());
  }

  // --- audit the request before anything leaves the process --------------
  await audit.write({ event: 'tool_request', ctx, tool: def.name, params });

  try {
    const outcome = await def.handler(params, ctx);
    const envelope = wrap(
      {
        tool: def.name,
        units: outcome.units,
        rowCount: outcome.rowCount,
        truncated: outcome.truncated,
        asOf: outcome.asOf,
        ...(outcome.fromCache === undefined ? {} : { fromCache: outcome.fromCache }),
        coverage: outcome.coverage,
        dataQuality: outcome.dataQuality,
      },
      outcome.data,
    );

    await audit.write({
      event: 'tool_outcome',
      ctx,
      tool: def.name,
      klipCalls: outcome.klipCalls.map((c) => ({ path: c.pathname, status: c.status, ms: c.durationMs })),
      rowCount: outcome.rowCount,
      latencyMs: Date.now() - started,
      outcome: 'OK',
      detail: {
        truncated: outcome.truncated,
        cached: outcome.fromCache ?? false,
        fetched_rows: outcome.coverage?.fetched_rows ?? outcome.rowCount,
      },
    });

    return successResult(envelope);
  } catch (err) {
    const gwErr = toGatewayError(err);

    // A guard block is a coding defect or tampering: its own event, high severity.
    if (err instanceof GuardError) {
      await audit
        .write({
          event: 'guard_block',
          ctx,
          tool: def.name,
          latencyMs: Date.now() - started,
          outcome: 'GUARD_BLOCK',
          detail: { ...(gwErr.detail ?? {}), severity: 'high' },
        })
        .catch(() => undefined);
      logger.error({ tool: def.name, detail: gwErr.detail }, 'GUARD_BLOCK - page the owner');
    } else {
      await audit
        .write({
          event: 'tool_outcome',
          ctx,
          tool: def.name,
          latencyMs: Date.now() - started,
          outcome: gwErr.code,
          detail: gwErr.detail === undefined ? {} : gwErr.detail,
        })
        .catch(() => undefined);
    }

    if (!(err instanceof GatewayError)) {
      // Log the real reason locally; the model only ever sees the typed shape.
      logger.error({ tool: def.name, err: (err as Error).message }, 'unhandled tool failure');
    }

    return errorResult(def.name, gwErr.toToolError());
  }
}
