/**
 * Downstream Hub TLS guards.
 *
 * The Hub decides WHO a user is, so the link to it carries the same weight as the
 * database link - and the gateway trusts what comes back over it. Over plaintext the
 * jwks_uri fetch is substitutable, which lets an attacker on that path forge an ID
 * token for any user; signature verification then proves nothing.
 *
 * config.ts calls process.exit(1), so these run it in a child process.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function boot(env: Record<string, string>): { status: number; output: string } {
  const base: Record<string, string> = {
    ...process.env,
    NODE_ENV: 'production',
    PUBLIC_URL: 'https://mcp-gw.example.com',
    KLIP_ENV: 'staging',
    KLIP_BASE_URL: 'http://10.0.0.10:5001/api',
    KLIP_SVC_USER: 'svc-mcp@example.com',
    KLIP_SVC_PASS: 'a-long-enough-password',
    OAUTH_SIGNING_KEY_PATH: 'secrets/oauth_signing.pem',
    DATABASE_URL: 'postgres://u:p@pgm-abc.pgsql.ap-southeast-5.rds.aliyuncs.com:5432/db',
    HUB_CLIENT_ID: 'mcp-gw',
    ...env,
  };
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./src/core/config.ts').then(() => console.log('BOOTED'));"],
    { env: base, encoding: 'utf8', timeout: 30_000 },
  );
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const HTTP_HUB = 'http://test-dwshub.example.com';
const HTTPS_HUB = 'https://test-dwshub.example.com';

describe('a plaintext Hub', () => {
  it('is REFUSED by default, rather than quietly trusted', () => {
    const a = boot({ HUB_ISSUER: HTTP_HUB });
    expect(a.status).not.toBe(0);
    expect(a.output).toContain('plaintext http');
    // Names the actual consequence, so the message cannot be read as pedantry.
    expect(a.output).toContain('forge an ID token');
  });

  it('is permitted for a staging pilot WITH the acknowledgement, and says so loudly', () => {
    const a = boot({ HUB_ISSUER: HTTP_HUB, HUB_ACK_PLAINTEXT: 'true' });
    expect(a.output).toContain('BOOTED');
    expect(a.output).toContain('PLAINTEXT Downstream Hub connection, explicitly acknowledged');
    expect(a.output).toContain('Stage 7');
  });

  it('is REFUSED in production EVEN WITH the acknowledgement', () => {
    // The escape hatch buys time for a staging pilot. It must not become the
    // production posture by the simple act of flipping KLIP_ENV.
    const a = boot({
      HUB_ISSUER: HTTP_HUB,
      HUB_ACK_PLAINTEXT: 'true',
      KLIP_ENV: 'production',
      KLIP_BASE_URL: 'http://10.0.0.20:5001/api',
    });
    expect(a.status).not.toBe(0);
    expect(a.output).toContain('no acknowledged-plaintext path in production');
  });

  it('is caught when only the DISCOVERY url is plaintext', () => {
    // An https issuer with an http discovery document still exposes the metadata
    // that names jwks_uri, so checking the issuer alone would miss it.
    const a = boot({
      HUB_ISSUER: HTTPS_HUB,
      HUB_DISCOVERY_URL: `${HTTP_HUB}/api/sso/.well-known/openid-configuration`,
    });
    expect(a.status).not.toBe(0);
    expect(a.output).toContain('plaintext http');
  });
});

describe('an https Hub', () => {
  it('boots with no plaintext warning at all', () => {
    const a = boot({ HUB_ISSUER: HTTPS_HUB });
    expect(a.output).toContain('BOOTED');
    expect(a.output).not.toContain('PLAINTEXT Downstream Hub');
  });

  it('is unaffected by a stray acknowledgement', () => {
    const a = boot({ HUB_ISSUER: HTTPS_HUB, HUB_ACK_PLAINTEXT: 'true' });
    expect(a.output).toContain('BOOTED');
    expect(a.output).not.toContain('PLAINTEXT Downstream Hub');
  });

  it('allows a loopback Hub for local development', () => {
    const a = boot({ HUB_ISSUER: 'http://localhost:9000' });
    expect(a.output).toContain('BOOTED');
    expect(a.output).not.toContain('PLAINTEXT Downstream Hub');
  });
});
