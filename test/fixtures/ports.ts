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
} as const;
