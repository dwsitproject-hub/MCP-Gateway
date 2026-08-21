/**
 * Standalone runner for the mock Downstream Hub, so the whole browser round trip
 * can be exercised against a real deployment.
 *
 *   npx tsx test/fixtures/runMockHub.ts [port] [issuer]
 *
 * The optional `issuer` matters when the gateway runs in a container: it reaches
 * the host as host.docker.internal, and the relying party REQUIRES the discovery
 * document's `issuer` to equal the configured HUB_ISSUER. Pass the same value the
 * container is configured with, e.g.
 *
 *   npx tsx test/fixtures/runMockHub.ts 5192 http://host.docker.internal:5192
 */
import { startMockHub } from './mockHub.js';

const port = Number(process.argv[2] ?? 5192);
const declaredIssuer = process.argv[3];

const options = declaredIssuer === undefined ? {} : { declaredIssuer, tokenIssuer: declaredIssuer };
// 0.0.0.0 so a container reaching the host as host.docker.internal can connect.
const hub = await startMockHub(port, options, '0.0.0.0');

process.stdout.write(`mock Downstream Hub listening on 127.0.0.1:${port}\n`);
process.stdout.write(`  declared issuer: ${declaredIssuer ?? hub.issuer}\n`);
process.stdout.write(`  client_id:       ${hub.clientId}\n`);

setInterval(() => undefined, 60_000);
