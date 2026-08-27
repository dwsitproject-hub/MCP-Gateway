/**
 * The runner must carry EVERY envelope field a tool returns.
 *
 * It used to enumerate them by hand and the enumeration fell behind: a next_step
 * override shipped and did nothing for two commits, because one line was missing. The
 * tool returned the right value and the runner dropped it. Nothing failed, because both
 * the unit test and the integration helper built the envelope THEMSELVES rather than
 * going through the runner - so the only untested code was the code that was wrong.
 *
 * These go through runTool, which is the path production uses.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition, ToolOutcome } from '../src/tools/klip/types.js';

process.env.CACHE_TTL_SECONDS = '0';

/**
 * The runner fails CLOSED when the audit store is unreachable - review H9.4, and
 * correct: a call that cannot be attributed must not happen. There is no database here,
 * so audit is stubbed. The stub is deliberately narrow: it records nothing and asserts
 * nothing, because what is under test is the envelope wiring, not the audit contract
 * (covered in audit.spec.ts).
 */
vi.mock('../src/core/audit.js', () => ({
  write: async () => undefined,
  newRequestId: () => 'stub-request-id',
  queueDepth: () => 0,
  isHealthy: () => true,
  flush: async () => undefined,
  redact: (v: unknown) => v,
}));

const { runTool } = await import('../src/mcp/runner.js');

const ctx = { requestId: 'runner-envelope', userId: 'tester@example.com' };

function toolReturning(outcome: Partial<ToolOutcome>): ToolDefinition {
  return {
    name: 'fake_tool',
    title: 'Fake',
    cap: 1,
    description: 'READ-ONLY test double.',
    inputShape: {},
    async handler(): Promise<ToolOutcome> {
      return {
        data: { ok: true },
        units: null,
        rowCount: 0,
        truncated: false,
        asOf: new Date('2026-08-27T10:00:00Z'),
        klipCalls: [],
        ...outcome,
      };
    },
  };
}

function payload(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe('runTool passes the tool outcome to the envelope', () => {
  it('carries a tool-supplied next_step through to the wire', async () => {
    const def = toolReturning({ truncated: true, nextStep: 'A very specific instruction.' });
    const env = payload(await runTool(def, {}, ctx));
    expect(env.next_step).toBe('A very specific instruction.');
  });

  it('falls back to the default hint when the tool supplies none', async () => {
    const def = toolReturning({ truncated: true });
    const env = payload(await runTool(def, {}, ctx));
    expect(String(env.next_step)).toMatch(/cover only part of the matching data/i);
  });

  it('emits no hint at all when nothing is truncated', async () => {
    const env = payload(await runTool(toolReturning({}), {}, ctx));
    expect(env.next_step).toBeUndefined();
  });

  it('carries units, coverage and data_quality through as well', async () => {
    // The same omission could have happened to any of these. Asserting them together
    // means the destructuring is what is under test, not one field.
    const def = toolReturning({
      units: 'MT',
      rowCount: 7,
      coverage: { fetched_rows: 7, total_rows: 70, pages_fetched: 1, total_pages: 10 },
      dataQuality: { missing_basis_quantity: 3 },
    });
    const env = payload(await runTool(def, {}, ctx));
    expect(env.units).toBe('MT');
    expect(env.row_count).toBe(7);
    expect(env.coverage).toMatchObject({ fetched_rows: 7, total_rows: 70 });
    expect(env.data_quality).toMatchObject({ missing_basis_quantity: 3 });
  });

  it('does not leak klipCalls into the envelope', async () => {
    // Excluded deliberately: it is an audit record, not something the model should read.
    const def = toolReturning({ klipCalls: [{ pathname: '/api/contracts', status: 200, durationMs: 12 }] });
    const env = payload(await runTool(def, {}, ctx));
    expect(Object.keys(env)).not.toContain('klipCalls');
    expect(JSON.stringify(env)).not.toContain('durationMs');
  });
});
