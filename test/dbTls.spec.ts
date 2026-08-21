/**
 * Database TLS guards.
 *
 * The store moved from a container on the compose network to a managed instance
 * across the VPC, so this link now carries OAuth token hashes and the whole audit
 * trail over a real network. The default must be encrypted, and the insecure choice
 * must be impossible to make by accident.
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
    ...env,
  };
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./src/core/config.ts').then(() => console.log('BOOTED'));"],
    { env: base, encoding: 'utf8', timeout: 30_000 },
  );
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const REMOTE = 'postgres://u:p@pgm-abc.pgsql.ap-southeast-5.rds.aliyuncs.com:5432/db';
const PRIVATE = 'postgres://u:p@172.28.92.66:5432/db';
const LOCAL = 'postgres://u:p@db:5432/db';

describe('encrypted by default', () => {
  it('defaults to require, so forgetting the setting does not mean plaintext', () => {
    const a = boot({ DATABASE_URL: REMOTE });
    expect(a.output).toContain('BOOTED');
    // ...and says so, because require does not authenticate the server.
    expect(a.output).toContain('does NOT verify the database server certificate');
  });

  it('accepts verify-full when a CA bundle is supplied', () => {
    const a = boot({ DATABASE_URL: REMOTE, DATABASE_SSL: 'verify-full', DATABASE_CA_PATH: '/tmp/ca.pem' });
    expect(a.output).toContain('BOOTED');
    expect(a.output).not.toContain('does NOT verify');
  });

  it('REFUSES verify-full with no CA bundle, rather than silently downgrading', () => {
    const a = boot({ DATABASE_URL: REMOTE, DATABASE_SSL: 'verify-full' });
    expect(a.status).not.toBe(0);
    expect(a.output).toContain('DATABASE_CA_PATH');
  });
});

describe('plaintext', () => {
  it('is allowed for a container-local database', () => {
    const a = boot({ DATABASE_URL: LOCAL, DATABASE_SSL: 'disable' });
    expect(a.output).toContain('BOOTED');
  });

  it('is REFUSED for a public managed endpoint', () => {
    const a = boot({ DATABASE_URL: REMOTE, DATABASE_SSL: 'disable' });
    expect(a.status).not.toBe(0);
    expect(a.output).toContain('unencrypted link');
  });

  it('is REFUSED for a public endpoint even WITH the acknowledgement', () => {
    // The escape hatch is scoped to private addresses. A hostname could resolve
    // anywhere, so acknowledging it proves nothing about the path.
    const a = boot({
      DATABASE_URL: REMOTE,
      DATABASE_SSL: 'disable',
      DATABASE_SSL_ACK_PLAINTEXT: 'true',
    });
    expect(a.status).not.toBe(0);
    expect(a.output).toContain('no acknowledged-plaintext path');
  });

  it('is REFUSED for a private address without the acknowledgement', () => {
    const a = boot({ DATABASE_URL: PRIVATE, DATABASE_SSL: 'disable' });
    expect(a.status).not.toBe(0);
    expect(a.output).toContain('DATABASE_SSL_ACK_PLAINTEXT');
  });

  it('is permitted for a private address WITH the acknowledgement, and says so loudly', () => {
    const a = boot({
      DATABASE_URL: PRIVATE,
      DATABASE_SSL: 'disable',
      DATABASE_SSL_ACK_PLAINTEXT: 'true',
    });
    expect(a.output).toContain('BOOTED');
    expect(a.output).toContain('PLAINTEXT database connection, explicitly acknowledged');
    // Names what is exposed, so the warning cannot be skimmed past.
    expect(a.output).toContain('audit trail');
  });
});
