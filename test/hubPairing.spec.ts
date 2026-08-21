/**
 * Hub / KLIP environment pairing.
 *
 * There are two Downstream Hub instances (the testing DWS Hub and production), so
 * the identity provider and the data source can be paired wrongly. One direction is
 * dangerous rather than merely untidy:
 *
 *   KLIP production + TEST Hub  -> anyone who can create a test-Hub account reaches
 *                                  real commercial data. FATAL.
 *   KLIP staging + PRODUCTION Hub -> only confusing. Warns.
 *
 * config.ts calls process.exit(1) on the fatal case, so this exercises the
 * predicate through a child process rather than by importing the module.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

interface Attempt {
  status: number;
  output: string;
}

function boot(env: Record<string, string>): Attempt {
  const base: Record<string, string> = {
    ...process.env,
    NODE_ENV: 'development',
    PUBLIC_URL: 'https://mcp-gw.example.com',
    DATABASE_URL: 'postgres://gateway:pw@127.0.0.1:1/none',
    KLIP_SVC_USER: 'svc-mcp@example.com',
    KLIP_SVC_PASS: 'a-long-enough-password',
    OAUTH_SIGNING_KEY_PATH: 'secrets/oauth_signing.pem',
    HUB_CLIENT_ID: 'mcp-gateway',
    HUB_CLIENT_SECRET: 'gateway-secret',
    ...env,
  };
  // spawnSync, not execFileSync: the staging-vs-production warning is written to
  // stderr, which execFileSync discards when the child exits successfully.
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./src/core/config.ts').then(() => console.log('BOOTED'));"],
    { env: base, encoding: 'utf8', timeout: 30_000 },
  );
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('Hub / KLIP environment pairing', () => {
  it('REFUSES production KLIP data behind a testing Hub', () => {
    const attempt = boot({
      KLIP_ENV: 'production',
      KLIP_BASE_URL: 'http://10.0.0.10:5001/api',
      HUB_ISSUER: 'https://hub-testing.example.com',
    });
    expect(attempt.status).not.toBe(0);
    expect(attempt.output).toContain('non-production identity provider');
    expect(attempt.output).not.toContain('BOOTED');
  });

  it('accepts production KLIP with the production Hub', () => {
    const attempt = boot({
      KLIP_ENV: 'production',
      KLIP_BASE_URL: 'http://10.0.0.10:5001/api',
      HUB_ISSUER: 'https://hub.example.com',
    });
    expect(attempt.output).toContain('BOOTED');
  });

  it('accepts staging KLIP with the testing Hub, which is the normal pairing', () => {
    const attempt = boot({
      KLIP_ENV: 'staging',
      KLIP_BASE_URL: 'http://klip-staging.example.com:5001/api',
      HUB_ISSUER: 'https://hub-testing.example.com',
    });
    expect(attempt.output).toContain('BOOTED');
    expect(attempt.output).not.toContain('WARNING');
  });

  it('warns, but still boots, for staging KLIP against the production Hub', () => {
    const attempt = boot({
      KLIP_ENV: 'staging',
      KLIP_BASE_URL: 'http://klip-staging.example.com:5001/api',
      HUB_ISSUER: 'https://hub.example.com',
    });
    expect(attempt.output).toContain('BOOTED');
    expect(attempt.output).toContain('looks like the PRODUCTION Hub');
  });

  it('still refuses a production KLIP_ENV pointed at a staging KLIP host', () => {
    // The pre-existing H7 guard must keep working alongside the Hub check.
    const attempt = boot({
      KLIP_ENV: 'production',
      KLIP_BASE_URL: 'http://klip-staging.example.com:5001/api',
      HUB_ISSUER: 'https://hub.example.com',
    });
    expect(attempt.status).not.toBe(0);
    expect(attempt.output).toContain('non-production host');
  });
});
