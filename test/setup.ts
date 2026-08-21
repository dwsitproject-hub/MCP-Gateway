/**
 * Test environment. Loaded by vitest before any module imports src/core/config.ts,
 * so the fail-fast config loader has a valid environment to parse.
 */
process.env.NODE_ENV = 'test';
process.env.PUBLIC_URL ??= 'https://mcp.test.local';
process.env.DATABASE_URL ??= 'postgres://gateway:gateway@127.0.0.1:5432/gateway_test';
process.env.KLIP_ENV ??= 'staging';
process.env.KLIP_BASE_URL ??= 'http://klip-staging.test.local:5001/api';
process.env.KLIP_SVC_USER ??= 'svc-mcp@example.com';
process.env.KLIP_SVC_PASS ??= 'test-service-password';
process.env.OAUTH_SIGNING_KEY_PATH ??= 'secrets/oauth_signing.pem';
process.env.CACHE_TTL_SECONDS ??= '0';
