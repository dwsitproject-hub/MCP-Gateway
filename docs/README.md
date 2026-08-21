# Documents

The design documents for this project are **not in this repository**, which is public.

| Document | Where it lives |
|---|---|
| PRD — MCP Gateway Phase 1 (KLIP) | internal document store · marked *Internal — IT Confidential* |
| TSD — MCP Gateway Phase 1 (KLIP) | internal document store · marked *Internal — IT Confidential* |
| Phase 1 Implementation Guide | internal |
| Phase 1 Design Review | internal — quotes both of the above |
| Deployment runbook (`deploy/RUNBOOK.md`) | internal — it is an operational map of a live host: public IP, SSH port, security-group layout and the kill-switch procedure |

They are excluded by `.gitignore` rather than deleted, so they stay on a maintainer's
disk without being publishable by accident.

## What the code here does say

Design decisions are documented at their call sites, so the source is readable without
the documents. In particular:

- `src/adapters/klip/routes.ts` and `fields.ts` — the KLIP contract, and what is still
  unverified. Production startup is gated on it.
- `src/adapters/klip/normalize.ts` — the Incoterm-driven outstanding-quantity rules,
  and why nulls propagate instead of coalescing to zero.
- `src/auth/hub.ts` — the Downstream Hub OIDC contract, including the places it
  departs from vanilla OIDC.
- `src/mcp/envelope.ts` — the result envelope, and why a truncated fetch must not
  publish a field called `totals`.
- `README.md` §8 — every deviation from the TSD, with the reason for each.

## Deployment values

Hostnames, IP addresses and account names are placeholders throughout
(`mcp-gw.example.com`, `10.0.0.10`, `svc-mcp@example.com`). Real values live only in
`/opt/mcp/.env` on the gateway host and in the internal runbook.
