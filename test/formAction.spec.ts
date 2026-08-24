/**
 * CSP form-action must name every origin a submission can END UP at.
 *
 * Chrome re-evaluates form-action on EVERY redirect hop; Firefox checks only the
 * initial POST target. Under a bare `form-action 'self'` the sign-in and Hub buttons
 * both post same-origin, receive a 302 to claude.ai or to the Hub, and Chrome silently
 * declines to follow it - no error page, no failed request, a successful 302 in the
 * server log, and a button that does nothing. It cost an afternoon on 2026-08-24.
 *
 * These assert the directive directly, because the failure is invisible end-to-end:
 * every HTTP exchange succeeds.
 */
import { describe, expect, it } from 'vitest';
import { loginCsp, LOGIN_CSP } from '../src/auth/loginPage.js';

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const HUB = 'http://test-dwshub.kpndomain.com';

function formAction(csp: string): string[] {
  const directive = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('form-action '));
  return (directive ?? '').replace('form-action ', '').split(' ').filter(Boolean);
}

describe('form-action', () => {
  it("names the OAuth client's redirect origin, or the approve button silently dies", () => {
    const sources = formAction(loginCsp([CLAUDE]));
    expect(sources).toContain("'self'");
    expect(sources).toContain('https://claude.ai');
  });

  it('names the Hub origin, or the Hub button silently dies', () => {
    expect(formAction(loginCsp([CLAUDE, HUB]))).toContain('http://test-dwshub.kpndomain.com');
  });

  it('lists the ORIGIN only, not the full callback path', () => {
    // A path-bearing source would not match the redirect and the block returns.
    expect(formAction(loginCsp([CLAUDE]))).not.toContain(CLAUDE);
  });

  it('does not widen to a wildcard', () => {
    // The directive still has to stop this page's forms being retargeted at an
    // attacker's collector - that is the whole reason to keep it.
    const sources = formAction(loginCsp([CLAUDE, HUB]));
    expect(sources).not.toContain('*');
    expect(sources).toHaveLength(3);
  });

  it('ignores a malformed target rather than degrading the policy', () => {
    expect(formAction(loginCsp(['', 'not a url', CLAUDE]))).toEqual(["'self'", 'https://claude.ai']);
  });

  it("falls back to 'self' alone when there is no outbound target", () => {
    expect(formAction(LOGIN_CSP)).toEqual(["'self'"]);
  });

  it('keeps the rest of the policy locked down', () => {
    const csp = loginCsp([CLAUDE]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
