/**
 * Audit redaction (S5).
 *
 * S5 requires that parameters containing suspected credentials are redacted. The
 * first implementation redacted purely by key name, which destroyed legitimate
 * audit content: the kill switch records `detail.refresh_tokens` as a COUNT, the
 * key matched /token/, and the count was stored as "[redacted]" - observed during
 * the S8 drill. Redaction must be aggressive about strings and inert about numbers.
 */
import { describe, expect, it } from 'vitest';
import { redact } from '../src/core/audit.js';

describe('audit redaction', () => {
  it('redacts credential-shaped values by key', () => {
    const out = redact({ password: 'hunter2', client_secret: 'abc', code_verifier: 'xyz' }) as Record<string, unknown>;
    expect(out.password).toBe('[redacted]');
    expect(out.client_secret).toBe('[redacted]');
    expect(out.code_verifier).toBe('[redacted]');
  });

  it('redacts a long random-looking string even under an innocent key', () => {
    const out = redact({ note: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IkFCQ0RFRkdIIn0' }) as Record<string, unknown>;
    expect(out.note).toBe('[redacted]');
  });

  it('leaves NUMBERS intact even when the key looks credential-ish', () => {
    const out = redact({ refresh_tokens: 0, tokens_revoked: 42, access_token_ttl: 3600 }) as Record<string, unknown>;
    expect(out.refresh_tokens).toBe(0);
    expect(out.tokens_revoked).toBe(42);
    expect(out.access_token_ttl).toBe(3600);
  });

  it('leaves booleans and nulls intact', () => {
    const out = redact({ token_valid: true, token_expiry: null, truncated: false }) as Record<string, unknown>;
    expect(out.token_valid).toBe(true);
    expect(out.token_expiry).toBeNull();
    expect(out.truncated).toBe(false);
  });

  it('keeps ordinary tool parameters readable - the audit log has to be useful', () => {
    const out = redact({ plant: 'TJP', product: 'CPO', limit: 20, as_of_basis: 'current' }) as Record<string, unknown>;
    expect(out).toEqual({ plant: 'TJP', product: 'CPO', limit: 20, as_of_basis: 'current' });
  });

  it('recurses into nested structures and caps long arrays', () => {
    const out = redact({
      filters: { plant: 'Dumai', password: 'secret-value' },
      rows: Array.from({ length: 250 }, (_, i) => i),
    }) as { filters: Record<string, unknown>; rows: number[] };
    expect(out.filters.plant).toBe('Dumai');
    expect(out.filters.password).toBe('[redacted]');
    expect(out.rows).toHaveLength(100);
  });

  it('truncates long prose rather than storing it whole', () => {
    const prose = 'shipment delayed by weather at the jetty '.repeat(60);
    const out = redact({ remarks: prose }) as Record<string, string>;
    expect(out.remarks.length).toBeLessThan(600);
    expect(out.remarks).toContain('[truncated]');
    expect(out.remarks).toContain('shipment delayed');
  });

  it('redacts a long UNBROKEN alphanumeric blob, which looks like a secret', () => {
    // Prose has spaces; a 2000-character token-shaped run does not.
    const out = redact({ remarks: 'x'.repeat(2000) }) as Record<string, string>;
    expect(out.remarks).toBe('[redacted]');
  });
});
