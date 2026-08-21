/**
 * OAuth signing keys (TSD Section 8.2).
 *
 * RS256, private key from the host vault, public key published at
 * /.well-known/jwks.json with a stable kid so a future rotation can publish both.
 *
 * In production the key MUST already exist (it lives in the vault, mode 600). Only
 * development generates one on the fly, so a missing key in production is a
 * startup failure rather than a silently new signing identity that invalidates
 * every live token.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { calculateJwkThumbprint, exportJWK, type JWK } from 'jose';
import { cfg } from './../core/config.js';
import { logger } from './../core/logger.js';

export interface SigningKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
  publicJwk: JWK;
}

let keys: SigningKeys | undefined;

function generate(path: string): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pem, { mode: 0o600 });
  logger.warn({ path }, 'generated a new OAuth signing key (development only)');
  return pem;
}

export async function loadKeys(): Promise<SigningKeys> {
  if (keys !== undefined) return keys;

  const path = cfg.OAUTH_SIGNING_KEY_PATH;
  let pem: string;

  if (existsSync(path)) {
    pem = readFileSync(path, 'utf8');
  } else if (cfg.isProduction) {
    console.error(
      `FATAL: OAuth signing key not found at ${path}. In production the key must be provisioned in the vault - ` +
        'generating one here would silently invalidate every issued token.',
    );
    process.exit(1);
  } else {
    pem = generate(path);
  }

  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256');

  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  keys = { privateKey, publicKey, kid, publicJwk };
  logger.info({ kid }, 'OAuth signing key loaded');
  return keys;
}

export async function jwks(): Promise<{ keys: JWK[] }> {
  const loaded = await loadKeys();
  return { keys: [loaded.publicJwk] };
}
