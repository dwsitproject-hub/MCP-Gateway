/**
 * Mock Downstream Hub OIDC provider for tests.
 *
 * Serves a real discovery document, a real JWKS, and signs real RS256 ID tokens,
 * so the relying party in src/auth/hub.ts is exercised for what actually matters:
 * signature verification, issuer and audience binding, expiry, and nonce replay.
 *
 * Every knob needed to produce a BAD token is exposed, because the negative cases
 * are the point.
 */
import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export interface MockHubOptions {
  /** The client id this Hub knows about. Defaults to a test value. */
  clientId?: string;
  /** Overrides the `issuer` in the discovery document (to test the mismatch guard). */
  declaredIssuer?: string;
  /** Overrides the `iss` claim in the ID token. */
  tokenIssuer?: string;
  /** Overrides the `aud` claim in the ID token. */
  tokenAudience?: string;
  /**
   * The `nonce` to sign into the ID token. Tests set this to the nonce the relying
   * party generated. Left unset, no nonce claim is emitted at all - which is itself
   * a case worth testing, since a missing nonce must be refused.
   */
  nonce?: string;
  /** Seconds until expiry; negative produces an already-expired token. */
  expiresInSeconds?: number;
  /** Sign with a key that is NOT published in the JWKS. */
  signWithForeignKey?: boolean;
  /** Return an OAuth error from the token endpoint. */
  tokenError?: string;
  /** Omit id_token from the token response. */
  omitIdToken?: boolean;
  /** Claims merged into the ID token. */
  claims?: Record<string, unknown>;
  /**
   * What to advertise as token_endpoint_auth_methods_supported. Undefined omits the
   * field entirely, which per RFC 8414 means client_secret_basic.
   */
  advertisedTokenAuthMethods?: string[];
  /** Reject any credential presentation other than this one, as a strict Hub would. */
  requireTokenAuthMethod?: 'client_secret_basic' | 'client_secret_post';
  /**
   * Path prefix for the OIDC endpoints. DWS Hub serves them under /api/sso, so the
   * discovery document is NOT at the RFC 8414 path derived from the issuer.
   */
  pathPrefix?: string;
  /**
   * Reject a form-encoded token body with `unsupported_grant_type`, as DWS Hub does.
   * This is the single most surprising part of that Hub's contract.
   */
  requireJsonBody?: boolean;
  /** The inverse: reject a JSON body, to exercise the fallback in the other direction. */
  requireFormBody?: boolean;
  /** What to advertise as scopes_supported. */
  advertisedScopes?: string[];
}

export interface MockHub {
  server: Server;
  issuer: string;
  clientId: string;
  clientSecret: string;
  options: MockHubOptions;
  /** Records what the relying party actually sent to the token endpoint. */
  tokenRequests: Array<Record<string, string>>;
  /** Records the authorization requests the browser was redirected with. */
  authorizeRequests: Array<Record<string, string>>;
  /** How the relying party actually presented its credentials on the last call. */
  observedTokenAuth?: 'client_secret_basic' | 'client_secret_post' | 'none';
  /** How the token request body was encoded on the last call. */
  observedTokenBody?: 'json' | 'form';
  reset(): void;
}

const DEFAULT_CLIENT_ID = 'mcp-gateway-test-client';
const CLIENT_SECRET = 'mcp-gateway-test-secret';

export async function startMockHub(
  port: number,
  options: MockHubOptions = {},
  /**
   * Bind address. Defaults to loopback for unit tests. A containerised gateway
   * reaching the host as host.docker.internal needs a non-loopback bind, so the
   * standalone runner passes '0.0.0.0'.
   */
  bindHost = '127.0.0.1',
): Promise<MockHub> {
  const issuer = `http://127.0.0.1:${port}`;
  // Captured at startup: reset() clears options, but the registered client id is a
  // property of the Hub itself, not of a single test's scenario.
  const CLIENT_ID = options.clientId ?? DEFAULT_CLIENT_ID;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');

  const publicJwk: JWK = await exportJWK(publicKey);
  publicJwk.kid = 'mock-hub-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const hub: MockHub = {
    server: undefined as unknown as Server,
    issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    options,
    tokenRequests: [],
    authorizeRequests: [],
    reset() {
      hub.tokenRequests.length = 0;
      hub.authorizeRequests.length = 0;
      hub.observedTokenAuth = undefined;
      hub.observedTokenBody = undefined;
      issuedCodes.clear();
      for (const key of Object.keys(hub.options)) delete (hub.options as Record<string, unknown>)[key];
    },
  };

  interface IssuedCode {
    nonce: string | undefined;
    codeChallenge: string | undefined;
    redirectUri: string;
  }
  const issuedCodes = new Map<string, IssuedCode>();

  // Defaults to /oauth2, the shape a conventional provider uses. DWS Hub passes
  // '/api/sso' instead, which is exactly the case the RFC 8414 derived path misses.
  const prefix = (options.pathPrefix ?? '/oauth2').replace(/\/+$/, '');

  const app: Express = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // Served at BOTH the prefixed path and the root. DWS Hub publishes it under
  // /api/sso alongside its endpoints; a conventional provider publishes it at the
  // RFC 8414 root path. Supporting both lets one fixture model either.
  const discoveryPaths = prefix === '' ? ['/.well-known/openid-configuration']
    : [`${prefix}/.well-known/openid-configuration`, '/.well-known/openid-configuration'];
  app.get(discoveryPaths, (_req: Request, res: Response) => {
    // Endpoints are advertised under the DECLARED issuer, so a containerised relying
    // party is told a host it can actually reach. Advertising the bind address here
    // sent the gateway's token request to its own loopback and failed the exchange.
    const base = hub.options.declaredIssuer ?? issuer;
    res.json({
      issuer: base,
      authorization_endpoint: `${base}${prefix}/authorize`,
      token_endpoint: `${base}${prefix}/token`,
      jwks_uri: `${base}${prefix}/jwks`,
      userinfo_endpoint: `${base}${prefix}/userinfo`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: hub.options.advertisedScopes ?? ['openid', 'email', 'profile', 'groups'],
      ...(hub.options.advertisedTokenAuthMethods === undefined
        ? {}
        : { token_endpoint_auth_methods_supported: hub.options.advertisedTokenAuthMethods }),
    });
  });

  app.get(`${prefix}/jwks`, (_req: Request, res: Response) => {
    res.json({ keys: [publicJwk] });
  });

  /**
   * A functioning authorization endpoint, so the whole browser round trip can be
   * exercised: it remembers the nonce and PKCE challenge, then redirects back with
   * a code and the caller's state exactly as a real Hub would.
   */
  app.get(`${prefix}/authorize`, (req: Request, res: Response) => {
    const q = req.query as Record<string, string>;
    hub.authorizeRequests.push({ ...q });

    if (q.client_id !== CLIENT_ID) {
      res.status(400).json({ error: 'invalid_client' });
      return;
    }
    if (typeof q.redirect_uri !== 'string' || q.redirect_uri === '') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const code = randomBytes(16).toString('hex');
    issuedCodes.set(code, {
      nonce: typeof q.nonce === 'string' ? q.nonce : undefined,
      codeChallenge: typeof q.code_challenge === 'string' ? q.code_challenge : undefined,
      redirectUri: q.redirect_uri,
    });

    const back = new URL(q.redirect_uri);
    back.searchParams.set('code', code);
    if (typeof q.state === 'string') back.searchParams.set('state', q.state);
    res.redirect(302, back.toString());
  });

  app.post(`${prefix}/token`, async (req: Request, res: Response) => {
    hub.tokenRequests.push({ ...(req.body as Record<string, string>) });
    const contentType = String(req.headers['content-type'] ?? '');
    hub.observedTokenBody = contentType.includes('application/json') ? 'json' : 'form';

    // DWS Hub answers unsupported_grant_type to a form-encoded body. Note it names
    // the GRANT TYPE, not the encoding, which is why it misleads.
    if (hub.options.requireJsonBody === true && hub.observedTokenBody !== 'json') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }
    if (hub.options.requireFormBody === true && hub.observedTokenBody !== 'form') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    // A strict Hub accepts exactly one credential presentation. Record which one
    // arrived, and refuse the other, so the relying party's choice is really tested.
    const usedBasic = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Basic ');
    const usedPost = typeof (req.body as Record<string, string>).client_secret === 'string';
    hub.observedTokenAuth = usedBasic ? 'client_secret_basic' : usedPost ? 'client_secret_post' : 'none';

    if (hub.options.requireTokenAuthMethod !== undefined && hub.observedTokenAuth !== hub.options.requireTokenAuthMethod) {
      res.status(401).json({
        error: 'invalid_client',
        error_description: `this endpoint requires ${hub.options.requireTokenAuthMethod}`,
      });
      return;
    }

    if (hub.options.tokenError !== undefined) {
      res.status(400).json({ error: hub.options.tokenError, error_description: 'mock rejection' });
      return;
    }
    if (hub.options.omitIdToken === true) {
      res.json({ access_token: 'mock-access', token_type: 'Bearer' });
      return;
    }

    const body = req.body as Record<string, string>;
    const issued = issuedCodes.get(body.code ?? '');

    // Verify the gateway -> Hub PKCE leg when the code came from /oauth2/authorize.
    if (issued?.codeChallenge !== undefined) {
      const expected = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
      if (expected !== issued.codeChallenge) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      if (issued.redirectUri !== body.redirect_uri) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return;
      }
      issuedCodes.delete(body.code ?? ''); // single use
    }

    // An explicit option always wins, so negative tests can forge a bad token.
    const nonce = hub.options.nonce ?? issued?.nonce;

    const ttl = hub.options.expiresInSeconds ?? 300;
    const now = Math.floor(Date.now() / 1000);

    const signer = new SignJWT({
      email: 'someone@example.com',
      name: 'Jerry Hakim',
      groups: ['klip-connector-pilot', 'it-department'],
      ...(nonce === undefined ? {} : { nonce }),
      ...(hub.options.claims ?? {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'mock-hub-key' })
      .setIssuer(hub.options.tokenIssuer ?? issuer)
      .setAudience(hub.options.tokenAudience ?? CLIENT_ID)
      .setSubject('hub-subject-0001')
      .setIssuedAt(now)
      .setExpirationTime(now + ttl);

    const key = hub.options.signWithForeignKey === true ? foreign.privateKey : privateKey;
    res.json({ id_token: await signer.sign(key), access_token: 'mock-access', token_type: 'Bearer' });
  });

  hub.server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, bindHost, () => resolve(s));
  });

  return hub;
}
