/**
 * One place where every spec's mock-server port is allocated.
 *
 * Ports were previously hardcoded per spec. Two new specs picked 5191 and 5193, both
 * already taken, and the symptom appeared in a completely unrelated file: nine Hub tests
 * failed with "could not read the Hub's OIDC metadata (HTTP 404)" because a different
 * spec's mock had claimed the port first. Each spec passed in isolation.
 *
 * Adding a port here is the only safe way to add one. Duplicates are now a visible
 * collision in a single file rather than an intermittent failure somewhere else.
 */
export const PORTS = {
  integration: 5188,
  truncation: 5189,
  audit: 5190,
  hubGroupGate: 5191,
  guard: 5192,
  hubTokenAuth: 5193,
  hubPairing: 5194,
  coverageWarning: 5195,
  detailEnvelope: 5196,
  oilLoss: 5197,
  vocabulary: 5198,
  performanceSummary: 5199,
  shippingPerformance: 5200,
  jettyAtBerth: 5201,
  // Added 14 Sep 2026. Six specs were still hardcoding a port and bypassing this file
  // entirely - hub.spec.ts sat on 5190 (audit) and hubDws.spec.ts on 5194 (hubPairing).
  // Both are real duplicates, latent only because vitest happened not to run those
  // files at the same moment. That is the exact failure this registry was created for.
  hub: 5202,
  hubDws: 5203,
  hubNonce: 5204,
  adminUi: 5205,
} as const;
