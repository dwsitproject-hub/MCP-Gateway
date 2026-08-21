/**
 * Exhaustive method/path table for the adapter guard (T-6, PRD S1 layer b).
 *
 * The guard is the reason a write cannot leave this process even if a tool, a
 * prompt injection, or a coding mistake asks for one.
 */
import { describe, expect, it } from 'vitest';
import { resolveTarget, guardInternals } from '../src/adapters/klip/client.js';
import { GuardError } from '../src/core/errors.js';

const WRITE_METHODS = ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'put', 'delete'];

describe('adapter method guard', () => {
  it('permits GET on API paths', () => {
    for (const path of ['/contracts', '/contracts/4700012345', '/shipments', '/sap-master-v2/imports']) {
      expect(() => resolveTarget('GET', path)).not.toThrow();
    }
  });

  it('permits POST only on the service-account login path', () => {
    const target = resolveTarget('POST', '/auth/login');
    expect(target.pathname).toBe(guardInternals.LOGIN_PATHNAME);
  });

  it('blocks POST on every other path', () => {
    for (const path of ['/contracts', '/auth/login/../contracts', '/auth/logout', '/contracts/1/approve', '/auth/loginX']) {
      expect(() => resolveTarget('POST', path)).toThrow(GuardError);
    }
  });

  it('blocks every write method outright', () => {
    for (const method of WRITE_METHODS) {
      expect(() => resolveTarget(method as 'GET', '/contracts')).toThrow(GuardError);
      expect(() => resolveTarget(method as 'GET', '/auth/login')).toThrow(GuardError);
    }
  });

  it('blocks path traversal in every encoding it accepts', () => {
    for (const path of ['/../admin', '/contracts/../../admin', '/contracts/%2e%2e/admin', '/contracts\\..\\admin']) {
      expect(() => resolveTarget('GET', path)).toThrow(GuardError);
    }
  });

  it('blocks an absolute URL that would leave the configured KLIP origin', () => {
    for (const path of ['//evil.example.com/contracts', '/\\evil.example.com/x']) {
      expect(() => resolveTarget('GET', path)).toThrow(GuardError);
    }
  });

  it('blocks a path that escapes the API mount point', () => {
    // KLIP_BASE_URL ends in /api; a resolved path outside it is not ours to call.
    expect(guardInternals.BASE_PATH).toBe('/api');
    expect(() => resolveTarget('GET', '/')).toThrow(GuardError);
  });

  it('requires a leading slash, so a relative path cannot be misjoined', () => {
    expect(() => resolveTarget('GET', 'contracts')).toThrow(GuardError);
    expect(() => resolveTarget('GET', '')).toThrow(GuardError);
  });

  it('carries the blocked method and path in the audited detail', () => {
    try {
      resolveTarget('POST', '/contracts');
      expect.unreachable('guard should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GuardError);
      const guard = err as GuardError;
      expect(guard.code).toBe('GUARD_BLOCK');
      expect(guard.severity).toBe('high');
      expect(guard.detail).toEqual({ method: 'POST', path: '/contracts' });
      expect(guard.retryable).toBe(false);
    }
  });
});
