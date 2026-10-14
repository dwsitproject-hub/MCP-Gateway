/**
 * The DWS Hub data connection is optional and must never stop a gateway from booting
 * when it is absent - but once configured, a weak key or a plaintext link in production
 * is refused. config.ts calls process.exit(1), so these run it in a child process.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function boot(env: Record<string, string>): { status: number; output: string } {
  const base: Record<string, string> = {
    ...process.env,
    NODE_ENV: 'production',
    PUBLIC_URL: 'https://mcp-gw.example.com',
    KLIP_ENV: 'production',
    KLIP_BASE_URL: 'http://10.0.0.10:5001/api',
    KLIP_SVC_USER: 'svc-mcp@example.com',
    KLIP_SVC_PASS: 'a-long-enough-password',
    OAUTH_SIGNING_KEY_PATH: 'secrets/oauth_signing.pem',
    DATABASE_URL: 'postgres://u:p@pgm-abc.pgsql.ap-southeast-5.rds.aliyuncs.com:5432/db?sslmode=verify-full',
    HUB_ISSUER: 'https://dwshub.example.com',
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

const KEY = 'hubsvc_a-real-looking-service-key-0123456789';

describe('DWS Hub data connection at boot', () => {
  it('boots in production with no DWS Hub data connection at all', () => {
    const r = boot({});
    expect(r.output).toContain('BOOTED');
    expect(r.output).not.toContain('DWSHUB');
  });

  it('boots in production with an https link and a real key', () => {
    expect(boot({ DWSHUB_BASE_URL: 'https://hub.example.com/api/service/v1', DWSHUB_SERVICE_KEY: KEY }).output).toContain('BOOTED');
  });

  it('refuses a placeholder key once one is set', () => {
    const r = boot({ DWSHUB_BASE_URL: 'https://hub.example.com/api/service/v1', DWSHUB_SERVICE_KEY: 'hubsvc_changeme_changeme_changeme' });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('DWSHUB_SERVICE_KEY');
    expect(r.output).not.toContain('changeme_changeme');
  });

  it('refuses a plaintext link in production, and names the origin but never the key', () => {
    const r = boot({ DWSHUB_BASE_URL: 'http://10.0.0.20:4000/api/service/v1', DWSHUB_SERVICE_KEY: KEY });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('DWSHUB_BASE_URL is plaintext http (http://10.0.0.20:4000)');
    expect(r.output).not.toContain(KEY);
  });

  it('allows a plaintext link on staging, with a warning', () => {
    const r = boot({ KLIP_ENV: 'staging', DWSHUB_BASE_URL: 'http://10.0.0.20:4000/api/service/v1', DWSHUB_SERVICE_KEY: KEY });
    expect(r.output).toContain('BOOTED');
    expect(r.output).toContain('Acceptable on staging only');
  });
});
