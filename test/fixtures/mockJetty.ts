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
  /**
   * Which cargo-progress shape to return. Production sends the keyed object; staging
   * sent an array. Both are in the wild, so both are testable.
   */
  cargoShape: 'object' | 'array';
  /** Stale plans with an ETA in the past and no TA, appended to /shipment-plans. */
  staleOverduePlans?: number;
  /** Per-vessel gauge state, distinct from the port-level ATG health. */
  gaugeConnected: boolean;
  /**
   * What the tank farm's mass column is actually in. JPS labels only density, so the
   * tool works this out from volume x density; 'broken' returns figures that match
   * neither reading, which must be reported as unknown rather than rounded into one.
   */
  tankMassUnit: 'kg' | 'tonne' | 'broken';
}

export function freshJettyState(): MockJettyState {
  return { requests: [], staleSources: 0, cargoShape: 'object', gaugeConnected: true, tankMassUnit: 'kg' };
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
    /**
     * PRODUCTION's shape, measured 16 Sep 2026: an OBJECT keyed by operation id, with
     * null where JPS has no gauge reading, the total spelled siQty, and no operationId
     * inside the value. Staging returned an array of rows instead.
     *
     * The mock follows PRODUCTION because that is what the connector serves. The array
     * form is covered by its own test - a mock that kept the friendlier shape would
     * have gone on passing while the tool threw "not iterable" against the real thing,
     * which is exactly what happened.
     */
    if (state.cargoShape === 'array') {
      // Staging's shape: rows carrying their own operationId, total spelled totalQty.
      res.json({ summaries: [{ operationId: '901', movedQty: 1470, totalQty: 3500 }] });
      return;
    }
    res.json({
      summaries: {
        '901': {
          connected: state.gaugeConnected,
          source: 'ATG',
          movedQty: 1470,
          siQty: 3500,
          siMetric: 'MT',
          completionPercent: 42,
        },
        '902': null,
      },
    });
  });

  // The Live Ops board's plan list, called with NO params (a date window would hide overdue ETAs).
  // One case per dashboard rule: waiting, arriving inside the window, overdue, outside the window,
  // no-ETA-but-ETB, rejected, and already alongside or sailed.
  app.get('/api/v1/shipment-plans', (req: Request, res: Response) => {
    if (!requireBearer(req, res)) return;
    const h = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
    const si = (short: string, qty: number) => [{ breakdown: [{ commodityName: short + ' long', commodityShortName: short, qty, metricCode: 'MT' }] }];
    res.json([
      { id: 1, vesselName: 'BG WAITING ONE', agentName: 'PAAM', vesselCapacity: 2500, jettyName: 'Jetty 5', ta: h(-240), tb: null, etb: h(24), purposeCode: 'Unloading', approvalStatus: 'Draft', shippingInstructions: si('COAL', 2400) },
      { id: 2, vesselName: 'MT ARRIVING SOON', agentName: 'TPB', vesselCapacity: 9000, jettyName: 'Jetty 2B', eta: h(10), ta: null, tb: null, purposeCode: 'Loading', approvalStatus: 'Submitted', shippingInstructions: si('FAME', 8800) },
      { id: 3, vesselName: 'MT OVERDUE ETA', agentName: 'TPB', vesselCapacity: 5000, eta: h(-60), ta: null, tb: null, purposeCode: 'Loading', approvalStatus: 'Draft', shippingInstructions: si('FAME', 5000) },
      { id: 4, vesselName: 'MV FAR AWAY', eta: h(24 * 10), ta: null, tb: null, purposeCode: 'Loading', approvalStatus: 'Approved', shippingInstructions: [] },
      { id: 5, vesselName: 'BG NO ETA', eta: null, etb: h(30), ta: null, tb: null, purposeCode: 'Unloading', approvalStatus: 'Approved', shippingInstructions: si('CPO', 3000) },
      { id: 6, vesselName: 'BG REJECTED', eta: h(5), ta: null, tb: null, purposeCode: 'Loading', approvalStatus: 'Rejected', shippingInstructions: [] },
      { id: 7, vesselName: 'BG ALONGSIDE', ta: h(-30), tb: h(-20), purposeCode: 'Loading', approvalStatus: 'Approved', shippingInstructions: [] },
      ...Array.from({ length: state.staleOverduePlans ?? 0 }, (_, i) => (
        { id: 1000 + i, vesselName: `MT STALE ${i}`, eta: h(-24 * (100 + i)), ta: null, tb: null, purposeCode: 'Loading', approvalStatus: 'Draft', shippingInstructions: [] })),
    ]);
  });

  // Sailed in the last 72 h (the board's Sailed tile); two rows for one plan count once.
  app.get('/api/v1/operations', (req: Request, res: Response) => {
    if (!requireBearer(req, res)) return;
    const h = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
    if (req.query.status !== 'SAILED') { res.json([]); return; }
    res.json([
      { id: 801, shipmentPlanId: 50, status: 'SAILED', castOffAt: h(-10) },
      { id: 802, shipmentPlanId: 50, status: 'SAILED', castOffAt: h(-10) },
      { id: 803, shipmentPlanId: 51, status: 'SAILED', castOffAt: h(-30) },
      { id: 804, shipmentPlanId: 52, status: 'SAILED', castOffAt: h(-100) },
    ]);
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

  // The odd one out: port arrives as a QUERY parameter here and the route 400s without
  // it, unlike every other endpoint which reads the x-port-id header.
  app.get('/api/v1/tank-gauging/latest', (req: Request, res: Response) => {
    if (!requireBearer(req, res)) return;
    if (req.query.portId === undefined) {
      res.status(400).json({ error: 'portId is required' });
      return;
    }
    const scale = state.tankMassUnit === 'kg' ? 1 : state.tankMassUnit === 'tonne' ? 1000 : 37;
    const tank = (code: string, product: string, volume: number, density: number) => ({
      tankId: code,
      code,
      name: `Tank ${code}`,
      productName: product,
      levelMm: 8200,
      temperatureC: 45.2,
      observedDensityKgM3: density,
      totalObservedVolume: volume,
      totalMass: (volume * density) / scale,
      flowRateTph: 0,
      statusText: 'Static',
      levelMovement: 'STABLE',
    });
    res.json([
      tank('T-01', 'CPO', 1000, 900),
      tank('T-02', 'CPO', 2000, 900),
      tank('T-03', 'PKO', 500, 920),
      // No mass reading at all: must be excluded from the total AND counted, never
      // silently treated as an empty tank.
      { tankId: 'T-04', code: 'T-04', name: 'Tank T-04', productName: 'CPO', levelMm: null,
        temperatureC: null, observedDensityKgM3: null, totalObservedVolume: null, totalMass: null,
        flowRateTph: null, statusText: 'Out of service', levelMovement: null },
    ]);
  });

  return app;
}
