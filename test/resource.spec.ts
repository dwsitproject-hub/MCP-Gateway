/**
 * RFC 8707 resource / audience binding (review B4, plus the confused-deputy guard
 * that live testing in production configuration exposed).
 *
 * The bug this locks down: honouring a client-supplied `resource` verbatim minted
 * tokens whose `aud` was not this server, so every /mcp call then rejected them -
 * and, worse, produced tokens audience-bound to a resource we do not control.
 *
 * PUBLIC_URL comes from test/setup.ts (https://mcp.test.local). Note that an
 * assignment to process.env inside this file would be too late: ESM hoists the
 * imports below, so config.ts is evaluated first.
 */
import { describe, expect, it } from 'vitest';
import { canonicalResource, ResourceMismatchError } from '../src/auth/tokens.js';
import { cfg } from '../src/core/config.js';

const ORIGIN = 'https://mcp.test.local';
const CANONICAL = `${ORIGIN}/mcp`;

describe('canonicalResource', () => {
  it('derives the canonical identifier as <PUBLIC_URL>/mcp', () => {
    expect(cfg.resourceIdentifier).toBe(CANONICAL);
  });

  it('binds to the canonical identifier when no resource is supplied', () => {
    expect(canonicalResource(undefined)).toBe(CANONICAL);
    expect(canonicalResource('')).toBe(CANONICAL);
  });

  it('accepts the canonical identifier and the bare origin', () => {
    expect(canonicalResource(CANONICAL)).toBe(CANONICAL);
    expect(canonicalResource(ORIGIN)).toBe(CANONICAL);
  });

  it('tolerates a trailing slash and an upper-case scheme or host', () => {
    // The specification asks servers to be robust about these forms.
    expect(canonicalResource(`${CANONICAL}/`)).toBe(CANONICAL);
    expect(canonicalResource(`${ORIGIN}/`)).toBe(CANONICAL);
    expect(canonicalResource('HTTPS://MCP.TEST.LOCAL/mcp')).toBe(CANONICAL);
  });

  it('rejects a resource that is not this server', () => {
    for (const foreign of [
      'http://localhost:8787/mcp', // the exact value that broke the live flow
      'https://mcp.test.local.evil.example/mcp',
      'https://evil.example/mcp',
      'http://mcp.test.local/mcp', // scheme downgrade
      'https://mcp.test.local/other',
      'https://sub.mcp.test.local/mcp',
    ]) {
      expect(() => canonicalResource(foreign), foreign).toThrow(ResourceMismatchError);
    }
  });

  it('never returns anything but the canonical identifier for an accepted form', () => {
    for (const accepted of [undefined, ORIGIN, CANONICAL, `${CANONICAL}/`]) {
      expect(canonicalResource(accepted)).toBe(CANONICAL);
    }
  });
});
