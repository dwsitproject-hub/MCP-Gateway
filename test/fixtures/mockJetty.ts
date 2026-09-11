/**
 * Minimal JPS mock.
 *
 * Deliberately reproduces the three things measured off staging on 11 Sep 2026, because
 * each one already caused or nearly caused a defect:
 *
 *   1. Login returns NO token in the body - only Set-Cookie jps_at, with jps_xsrf
 *      beside it. A mock that returned a body token would have hidden the fact that the
 *      client was dropping response headers entirely.
 *   2. /operations/at-berth is a BARE ARRAY, not { success, data }. JPS envelopes are
 *      mixed; a uniformly wrapped mock would agree with an assumption rather than with
 *      JPS.
 *   3. Rows carry nulls for unrecorded milestones, so "not recorded" can be told apart
 *      from zero.
 */
import express, { type Express, type Request, type Response } from 'express';

export interface MockJettyState {
  requests: Array<{ method: string; path: string; auth: string | undefined; portHeader: string | undefined }>;
  /** Flip to exercise the stale-ATG caveat. */
  staleSources: number;
}

export function freshJettyState(): MockJettyState {
  return { requests: [], staleSources: 0 };
}

/** A structurally real JWT with an 8-hour life, matching what JPS issues. */
function jwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: '32', iat: now, exp: now + 28_800 })}.sig`;
}

export function createMockJetty(state: MockJettyState): Express {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    state.requests.push({
      method: req.method,
      path: req.path,
      auth: req.get('authorization'),
      portHeader: req.get('x-port-id'),
    });
    next();
  });

  // Login: profile in the body, credential in the cookie. Exactly as measured.
  app.post('/api/v1/auth/login', (req: Request, res: Response) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (username === undefined || password === undefined) {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }
    if (username !== 'MCP') {
      // The staging account's username is MCP; the email does NOT authenticate.
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }
    res.setHeader('Set-Cookie', [
      `jps_at=${jwt()}; Max-Age=28800; Path=/; HttpOnly; SameSite=Lax`,
      'jps_xsrf=6ad7dbf0f5478dc44066b8db701afd68; Max-Age=28800; Path=/; SameSite=Lax',
    ]);
    res.json({ user: { id: '32', username: 'MCP', displayName: 'MCP', email: 'svc-mcp@energi-up.com' } });
  });

  const requireBearer = (req: Request, res: Response): boolean => {
    if (!(req.get('authorization') ?? '').startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthenticated' });
      return false;
    }
    return true;
  };

  // Bare array - no envelope.
  app.get('/api/v1/operations/at-berth', (req: Request, res: Response) => {
    if (!requireBearer(req, res)) return;
    const berthedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    res.json([
      {
        id: '901',
        jettyOperationCode: 'OP-901',
        vesselName: 'MT. GIAT ARMADA 02',
        jettyName: 'Jetty 1',
        purpose: 'Loading',
        status: 'IN_PROGRESS',
        commodityDisplay: 'CPO',
        cargoSiQty: 3500,
        cargoSiMetricCode: 'MT',
        referenceNumber: 'SI-5501',
        eta: '2026-09-11T00:00:00.000Z',
        ta: '2026-09-11T01:00:00.000Z',
        etb: '2026-09-11T02:00:00.000Z',
        tbAt: berthedAt,
        norTenderedAt: '2026-09-11T01:30:00.000Z',
        norAcceptedAt: '2026-09-11T02:30:00.000Z',
        demurrageLiabilityFromAt: '2026-09-11T02:30:00.000Z',
        estimatedCompletionTime: '2026-09-11T14:00:00.000Z',
        // Unrecorded, not zero - the distinction this connector keeps insisting on.
        operationsCompletedAt: null,
        actualCompletionTime: null,
        completionPercent: 42,
        exceptionStatus: null,
      },
      {
        id: '902',
        jettyOperationCode: 'OP-902',
        vesselName: 'EIHO',
        jettyName: 'Jetty 2',
        purpose: 'Unloading',
        status: 'DOCKED',
        commodityDisplay: 'PK',
        cargoSiQty: 1200,
        cargoSiMetricCode: 'MT',
        referenceNumber: 'SI-5502',
        eta: '2026-09-11T03:00:00.000Z',
        ta: '2026-09-11T04:00:00.000Z',
        etb: null,
        tbAt: null,
        dockingStartTime: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        norTenderedAt: null,
        norAcceptedAt: null,
        demurrageLiabilityFromAt: null,
        estimatedCompletionTime: null,
        operationsCompletedAt: null,
        completionPercent: 0,
        exceptionStatus: null,
      },
    ]);
  });

  app.get('/api/v1/operations/at-berth/cargo-progress', (req: Request, res: Response) => {
    if (!requireBearer(req, res)) return;
    res.json({ summaries: [{ operationId: '901', movedQty: 1470, totalQty: 3500 }] });
  });

  app.get('/api/v1/dashboard-v2/atg-sync-health', (req: Request, res: Response) => {
    if (!requireBearer(req, res)) return;
    res.json({
      staleThresholdMs: 3_600_000,
      checkedAt: new Date().toISOString(),
      totalEnabled: 3,
      staleCount: state.staleSources,
      allHealthy: state.staleSources === 0,
      sources: [],
      staleSources: [],
    });
  });

  return app;
}
