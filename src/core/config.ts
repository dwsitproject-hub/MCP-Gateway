/**
 * Fail-fast environment validation (SLMS convention; TSD Section 14).
 *
 * The process MUST refuse to start in production if any secret is missing or
 * left at a placeholder value. Review findings applied here:
 *  - "test" is a valid NODE_ENV (vitest sets it; the original skeleton threw on import).
 *  - KLIP_ENV is explicit so the result envelope cannot claim "production" while
 *    pointed at staging (review H7).
 *  - Placeholder detection covers every secret-bearing variable, not just one.
 *  - RATE_LIMIT_USER is parsed into numbers at boot rather than carried as a string.
 */
import { z } from 'zod';

// Note: in zod 4, .default() supplies the OUTPUT type, so the default must be
// declared on the string stage BEFORE .transform(), not after it.
const RateLimitSpec = z
  .string()
  .regex(/^\d+\/\d+s?$/, 'expected "<calls>/<seconds>" e.g. "30/300s"')
  .default('30/300s')
  .transform((raw) => {
    const [calls, window] = raw.replace(/s$/, '').split('/');
    return { calls: Number(calls), windowSeconds: Number(window) };
  });

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  BIND_ADDRESS: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /**
   * Opt-in human-readable logs. Deliberately NOT keyed on NODE_ENV: pino-pretty is a
   * devDependency, so a production image that tried to load it crash-looped at import.
   */
  LOG_PRETTY: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true' || v === '1'),

  /** Public origin of the gateway. Used for OAuth issuer, resource id and redirect validation. */
  PUBLIC_URL: z.string().url(),

  DATABASE_URL: z.string().min(10),
  /**
   * TLS to the database. The store is now a managed ApsaraDB instance reached over
   * the VPC rather than a container on the compose network, so the connection leaves
   * the host and must be encrypted.
   *
   *   verify-full - encrypt AND authenticate the server against DATABASE_CA_PATH.
   *                 The only setting that resists a man-in-the-middle; use it.
   *   require     - encrypt, but accept ANY certificate. Better than nothing, still
   *                 spoofable by anything that can occupy the network path.
   *   disable     - plaintext. Only for a container-local database.
   *
   * Relying on `?sslmode=` inside DATABASE_URL is deliberately avoided: how a driver
   * interprets it is subtle, and getting it silently wrong means an unencrypted
   * connection that looks fine.
   */
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('require'),
  /** PEM bundle for the database server's CA. Required when DATABASE_SSL=verify-full. */
  DATABASE_CA_PATH: z.string().optional(),
  /**
   * Deliberate, acknowledged acceptance of a PLAINTEXT link to a database on a
   * private address - for when the managed instance has TLS switched off and turning
   * it on needs a change window on a shared production server.
   *
   * Scoped narrowly on purpose: it does nothing for a public address, it is logged
   * loudly on every boot, and it exists so the decision is recorded in config rather
   * than made by editing the guard out. Remove it once TLS is enabled.
   */
  DATABASE_SSL_ACK_PLAINTEXT: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true' || v === '1'),

  /**
   * Which KLIP environment the adapter talks to. Surfaced in every tool result and
   * in the audit log so a staging answer can never claim to be production.
   */
  KLIP_ENV: z.enum(['staging', 'production']),
  KLIP_BASE_URL: z.string().url(),
  KLIP_SVC_USER: z.string().min(3),
  KLIP_SVC_PASS: z.string().min(12),
  KLIP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  OAUTH_SIGNING_KEY_PATH: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(60),

  RATE_LIMIT_USER: RateLimitSpec,

  /** Comma-separated browser origins permitted on /mcp when an Origin header is present. */
  ALLOWED_ORIGINS: z
    .string()
    .default('https://claude.ai,https://claude.com')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  /** Registered redirect URIs must live under one of these origins (T-8). */
  ALLOWED_REDIRECT_ORIGINS: z
    .string()
    .default('https://claude.ai,https://claude.com')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  // --- Downstream Hub OIDC (review H2) -------------------------------------
  // The Hub authenticates the human; the users table remains the pilot allowlist.
  // Only the issuer plus client credentials are needed - every endpoint is read
  // from the Hub's own /.well-known/openid-configuration document.
  HUB_ISSUER: z.string().url().optional(),
  HUB_CLIENT_ID: z.string().min(1).optional(),
  /**
   * DWS Hub is a PUBLIC client: token_endpoint_auth_methods_supported is ["none"]
   * and no client secret exists. Leave this unset for the Hub. It is kept only so a
   * future confidential provider can be pointed at without code changes.
   */
  HUB_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * Explicit discovery URL. DWS Hub serves OIDC under /api/sso, so the document is at
   *   https://<hub-host>/api/sso/.well-known/openid-configuration
   * which is NOT the RFC 8414 path derived from the issuer. When unset we fall back to
   * the standard <issuer>/.well-known/openid-configuration.
   */
  HUB_DISCOVERY_URL: z.string().url().optional(),
  /**
   * DWS Hub advertises only openid, profile and email. Requesting an unsupported
   * scope such as `groups` is at best ignored and at worst an invalid_scope error.
   */
  HUB_SCOPES: z.string().default('openid email profile'),
  /** Claim carrying the work email, if the Hub does not use `email`. */
  HUB_EMAIL_CLAIM: z.string().default('email'),
  /** Optional: require this value in the Hub's groups claim before admitting a user. */
  HUB_REQUIRED_GROUP: z.string().optional(),
  HUB_GROUPS_CLAIM: z.string().default('groups'),
  /**
   * Override how client credentials are presented at the Hub's token endpoint.
   * Normally read from `token_endpoint_auth_methods_supported` in discovery; set
   * this only when the Hub's metadata is incomplete or wrong. A mismatch shows up
   * as a 401 from the token endpoint that otherwise reads like bad credentials.
   */
  HUB_TOKEN_AUTH_METHOD: z.enum(['client_secret_basic', 'client_secret_post', 'none']).optional(),
  /**
   * How the token request body is encoded. DWS Hub requires JSON and answers
   * `unsupported_grant_type` to a form-encoded body - the opposite of nearly every
   * OAuth example. Defaults to JSON, with a one-shot fallback to form on that exact
   * error so a differently configured provider still works.
   */
  HUB_TOKEN_BODY: z.enum(['json', 'form']).default('json'),
  /** How long a Hub round trip may take before its state row expires. */
  HUB_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  /**
   * Acknowledge a plaintext http:// Downstream Hub.
   *
   * The Hub is the thing that decides WHO a user is, so the link to it carries the
   * same weight as the database link. Over http the jwks_uri fetch is the sharp edge:
   * substitute the key set and ID tokens for arbitrary users can be forged, which
   * turns signature verification into theatre. The authorization code and PKCE
   * verifier also cross the wire in clear - and PKCE defends against an intercepted
   * code, not against an observer who sees the verifier alongside it.
   *
   * Permitted for a staging pilot on an internal network, refused outright once
   * KLIP_ENV=production. Logged loudly on every boot either way.
   */
  HUB_ACK_PLAINTEXT: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true' || v === '1'),

  /**
   * The local password path, kept for exactly one break-glass account so the
   * connector can still be authorized when the Hub is down or misconfigured.
   * Set false once the Hub path is proven, to shrink the attack surface.
   */
  BREAK_GLASS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true' || v === '1'),

  /** Optional per-tool row cap overrides, as JSON. Defaults live in the tool definitions. */
  TOOL_ROW_CAPS_JSON: z.string().optional(),

  /** Bounded page walker (TSD Section 7.3). PAGE_SIZE must be <= KLIP's accepted limit. */
  KLIP_MAX_PAGES: z.coerce.number().int().positive().default(10),
  KLIP_PAGE_SIZE: z.coerce.number().int().positive().default(100),
  KLIP_FETCH_CONCURRENCY: z.coerce.number().int().positive().default(4),

  /** Short-lived read cache. 0 disables it. Cached results report their real as_of. */
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(60),
});

export type Config = z.infer<typeof Env> & {
  /** RFC 8707 canonical resource identifier for this MCP server (review B4). */
  resourceIdentifier: string;
  /** OAuth issuer identifier. */
  issuer: string;
  isProduction: boolean;
  /** True when Hub OIDC is fully configured, making it the primary login path. */
  hubEnabled: boolean;
  /** Where the Hub returns the browser after authentication. */
  hubRedirectUri: string;
  /** Resolved discovery URL: explicit if given, else the RFC 8414 derived path. */
  hubDiscoveryUrl: string | undefined;
};

const PLACEHOLDERS = ['changeme', 'change-me', 'your-secret', 'yoursecret', 'example', 'placeholder', 'todo', 'xxxx', 'secret123'];
const WEAK_VALUES = ['password', 'postgres', 'admin', 'secret', 'test', '12345678'];
const SECRET_KEYS = ['KLIP_SVC_PASS', 'DATABASE_URL'] as const;

function assertNoPlaceholderSecrets(cfg: z.infer<typeof Env>): void {
  if (cfg.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  for (const key of SECRET_KEYS) {
    const value = String(cfg[key] ?? '');
    const lower = value.toLowerCase();
    if (value.trim() === '') problems.push(`${key} is empty`);
    else if (PLACEHOLDERS.some((p) => lower.includes(p))) problems.push(`${key} contains a placeholder value`);
    else if (WEAK_VALUES.includes(lower)) problems.push(`${key} is a well-known weak value`);
  }
  if (problems.length > 0) {
    // Never echo the value itself - only the variable name (S5).
    console.error(`FATAL: refusing to boot in production:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
}

/**
 * The Downstream Hub link must be TLS for the same reason the database link must be:
 * it carries authentication material, and the gateway trusts what comes back from it.
 */
function assertHubTls(cfg: z.infer<typeof Env>): void {
  if (cfg.HUB_ISSUER === undefined) return;

  const urls = [cfg.HUB_ISSUER, cfg.HUB_DISCOVERY_URL].filter((u): u is string => u !== undefined);
  const plaintext = urls.filter((u) => {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:') return false;
    // Loopback is not a network path anyone can occupy.
    return !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  });
  if (plaintext.length === 0) return;

  const detail = [
    `  Affected: ${plaintext.join(', ')}`,
    '  Over plaintext the jwks_uri fetch can be substituted, letting an attacker on that',
    '  network path forge an ID token for ANY user - the pilot allowlist is then the only',
    '  thing standing between them and the connector. The authorization code and PKCE',
    '  verifier are also exposed together, which defeats PKCE.',
  ].join('\n');

  if (cfg.KLIP_ENV === 'production') {
    console.error(
      [
        'FATAL: Downstream Hub is configured over plaintext http, and KLIP_ENV=production.',
        detail,
        '  There is no acknowledged-plaintext path in production. Serve the Hub over https',
        '  and update HUB_ISSUER and HUB_DISCOVERY_URL.',
      ].join('\n'),
    );
    process.exit(1);
  }

  if (!cfg.HUB_ACK_PLAINTEXT) {
    console.error(
      [
        'FATAL: Downstream Hub is configured over plaintext http.',
        detail,
        '  Fix: serve the Hub over https. If it cannot be yet and the Hub is internal-only,',
        '  accept this deliberately for staging with HUB_ACK_PLAINTEXT=true - it is logged',
        '  on every boot and will refuse to start under KLIP_ENV=production.',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.warn(
    [
      'WARNING: PLAINTEXT Downstream Hub connection, explicitly acknowledged.',
      detail,
      '  Accepted only because this is a staging pilot on an internal network.',
      '  This MUST be resolved before Stage 7 - production will refuse to start.',
    ].join('\n'),
  );
}

function assertDatabaseTls(cfg: z.infer<typeof Env>): void {
  if (cfg.DATABASE_SSL === 'verify-full' && cfg.DATABASE_CA_PATH === undefined) {
    console.error('FATAL: DATABASE_SSL=verify-full requires DATABASE_CA_PATH (the database CA bundle).');
    process.exit(1);
  }
  // A plaintext connection to something that is not local is a real exposure, not a
  // preference: OAuth tokens and the whole audit trail cross that link.
  const local = /@(db|localhost|127\.0\.0\.1)[:/]/.test(cfg.DATABASE_URL);
  // RFC 1918 - a VPC-internal address. Narrower exposure than the public internet,
  // but still a network path other hosts in the VPC sit on.
  const privateHost = /@(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(cfg.DATABASE_URL);

  if (cfg.DATABASE_SSL === 'disable' && !local) {
    if (privateHost && cfg.DATABASE_SSL_ACK_PLAINTEXT) {
      console.warn(
        [
          'WARNING: PLAINTEXT database connection, explicitly acknowledged.',
          '  OAuth token hashes and the entire audit trail - user identities, tool',
          '  parameters - cross the VPC unencrypted. Any host able to occupy that',
          '  network path can read them.',
          '  Accepted only because the address is private and TLS is pending a change',
          '  window. Enable TLS on the instance, then remove DATABASE_SSL_ACK_PLAINTEXT.',
        ].join('\n'),
      );
    } else {
      console.error(
        [
          'FATAL: DATABASE_SSL=disable, but DATABASE_URL points at a remote host.',
          '  Refusing to send OAuth tokens and audit records over an unencrypted link.',
          '  Fix: enable TLS on the database, then set DATABASE_SSL=require (later verify-full).',
          privateHost
            ? '  If TLS cannot be enabled yet and the host is VPC-internal, this can be accepted' +
              '\n  deliberately with DATABASE_SSL_ACK_PLAINTEXT=true - it is logged on every boot.'
            : '  The host is not a private address, so there is no acknowledged-plaintext path.',
        ].join('\n'),
      );
      process.exit(1);
    }
  }

  if (cfg.NODE_ENV === 'production' && cfg.DATABASE_SSL === 'require') {
    console.warn(
      'WARNING: DATABASE_SSL=require encrypts but does NOT verify the database server certificate. ' +
        'Set DATABASE_SSL=verify-full with DATABASE_CA_PATH once you have the provider CA bundle.',
    );
  }
}

function assertEnvironmentCoherence(cfg: z.infer<typeof Env>): void {
  // A production build pointed at a staging URL (or vice versa) is the H7 failure mode.
  const base = cfg.KLIP_BASE_URL.toLowerCase();
  const looksStaging = /staging|stg|uat|dev|localhost|127\.0\.0\.1/.test(base);
  if (cfg.KLIP_ENV === 'production' && looksStaging) {
    console.error(`FATAL: KLIP_ENV=production but KLIP_BASE_URL looks like a non-production host: ${cfg.KLIP_BASE_URL}`);
    process.exit(1);
  }
  if (cfg.NODE_ENV === 'production' && cfg.PUBLIC_URL.startsWith('http://')) {
    console.error('FATAL: PUBLIC_URL must be https in production (S3).');
    process.exit(1);
  }

  // There are two Downstream Hub instances (a testing DWS Hub and production), so
  // the identity provider and the data source can be paired wrongly. Serving
  // PRODUCTION KLIP data to people authenticated by a TEST identity provider is the
  // dangerous direction: anyone who can create a test-Hub account would reach real
  // commercial data. That is fatal. The reverse is only confusing, so it warns.
  if (cfg.HUB_ISSUER !== undefined) {
    const hub = cfg.HUB_ISSUER.toLowerCase();
    const hubLooksNonProduction = /test|testing|staging|stg|uat|dev|sandbox|localhost|127\.0\.0\.1/.test(hub);

    if (cfg.KLIP_ENV === 'production' && hubLooksNonProduction) {
      console.error(
        `FATAL: KLIP_ENV=production but HUB_ISSUER looks like a non-production identity provider ` +
          `(${cfg.HUB_ISSUER}).\n` +
          '  Production KLIP data must not be released to users authenticated by a test Hub.\n' +
          '  Point HUB_ISSUER at the production Downstream Hub, with its own client registration.',
      );
      process.exit(1);
    }
    if (cfg.KLIP_ENV === 'staging' && !hubLooksNonProduction) {
      console.warn(
        `WARNING: KLIP_ENV=staging but HUB_ISSUER (${cfg.HUB_ISSUER}) looks like the PRODUCTION Hub. ` +
          'Staging work should normally use the testing Downstream Hub so real accounts are not ' +
          'consented against a staging connector.',
      );
    }
  }
}

function load(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    console.error(`FATAL: invalid environment configuration:\n${detail}`);
    process.exit(1);
  }
  const cfg = parsed.data;
  assertNoPlaceholderSecrets(cfg);
  assertDatabaseTls(cfg);
  assertHubTls(cfg);
  assertEnvironmentCoherence(cfg);

  const publicUrl = cfg.PUBLIC_URL.replace(/\/+$/, '');
  // A secret is NOT part of this: DWS Hub is a public client using PKCE.
  const hubEnabled = cfg.HUB_ISSUER !== undefined && cfg.HUB_CLIENT_ID !== undefined;

  if (!hubEnabled && !cfg.BREAK_GLASS_ENABLED) {
    console.error(
      'FATAL: no login path is available. Hub OIDC is not configured (needs HUB_ISSUER and ' +
        'HUB_CLIENT_ID) and BREAK_GLASS_ENABLED is false, so nobody could authorize the connector.',
    );
    process.exit(1);
  }
  if (!hubEnabled && cfg.NODE_ENV === 'production') {
    console.warn(
      'WARNING: production is running on the break-glass password path only. Configure HUB_ISSUER ' +
        'and HUB_CLIENT_ID so pilot users authenticate through Downstream Hub.',
    );
  }

  return {
    ...cfg,
    PUBLIC_URL: publicUrl,
    issuer: publicUrl,
    resourceIdentifier: `${publicUrl}/mcp`,
    isProduction: cfg.NODE_ENV === 'production',
    hubEnabled,
    hubRedirectUri: `${publicUrl}/authorize/hub/callback`,
    hubDiscoveryUrl:
      cfg.HUB_DISCOVERY_URL ??
      (cfg.HUB_ISSUER === undefined
        ? undefined
        : `${cfg.HUB_ISSUER.replace(/\/+$/, '')}/.well-known/openid-configuration`),
  };
}

export const cfg: Config = load();

/** Human-readable provenance string for the result envelope (review H7). */
export function sourceLabel(): string {
  return `KLIP ${cfg.KLIP_ENV} via read-only service account`;
}
