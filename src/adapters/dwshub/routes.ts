/**
 * DWS Hub service API routes (Hub: backend/src/routes/service.js, mounted at
 * /api/service/v1). Paths are relative to DWSHUB_BASE_URL.
 *
 * Like the JPS route table there is no method field: every route is a GET, and the
 * client cannot express anything else.
 */
export interface DwsHubRoute {
  path: string;
  notes: string;
}

export const dwshubRoutes = {
  status: { path: '/status', notes: 'Sentinel on/off, model, runs queued/running/done/failed today.' },
  applications: { path: '/applications', notes: 'Every application plus the Hub (scope "hub"): open reports, 7-day errors, latest health verdict.' },
  runs: { path: '/sentinel/runs', notes: 'Query: scope, kind (bug|health|ask), status, days (1-90), limit (1-50).' },
  run: { path: '/sentinel/runs', notes: 'Append /:id (uuid) for one run in full.' },
  bugReports: { path: '/bug-reports', notes: 'Query: scope, status (open|resolved), kind (user_report|client_error), days, limit.' },
  errors: { path: '/errors', notes: 'Query: scope (required), days.' },
} as const satisfies Record<string, DwsHubRoute>;
