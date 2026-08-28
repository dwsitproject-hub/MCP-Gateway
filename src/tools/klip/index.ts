/**
 * The KLIP tool registry.
 *
 * Adding a Phase 2 adapter means adding definitions and one adapter module -
 * no change to OAuth, audit or transport (PRD G5 / Section 12 Maintainability).
 *
 * There are no write tools here, and there is no code path that could add one:
 * this is layer (a) of the S1 defense in depth.
 */
import type { ToolDefinition, InputShape } from './types.js';
import { getContract } from './getContract.js';
import { outstanding } from './outstanding.js';
import { paymentStatus } from './paymentStatus.js';
import { qualitySurveys } from './qualitySurveys.js';
import { oilLoss } from './oilLoss.js';
import { performanceSummary } from './performanceSummary.js';
import { shippingPerformance } from './shippingPerformance.js';
import { reference } from './reference.js';
import { sapImportStatus } from './sapImportStatus.js';
import { searchContracts } from './searchContracts.js';
import { shipmentStatus } from './shipmentStatus.js';
import { truckingOps } from './truckingOps.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous input shapes
export const klipTools: ReadonlyArray<ToolDefinition<any>> = [
  // The eight from PRD Section 8...
  searchContracts,
  getContract,
  outstanding,
  shipmentStatus,
  truckingOps,
  qualitySurveys,
  oilLoss,
  performanceSummary,
  shippingPerformance,
  paymentStatus,
  sapImportStatus,
  // ...plus the reference lookup added from review finding H6.
  reference,
];

export function toolByName(name: string): ToolDefinition<InputShape> | undefined {
  return klipTools.find((t) => t.name === name) as ToolDefinition<InputShape> | undefined;
}

export const toolNames: readonly string[] = klipTools.map((t) => t.name);
