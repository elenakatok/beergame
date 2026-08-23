// functions/src/engine.ts
//
// Server-side port of the Beer Game round engine. The pure simulation logic
// (`simulateWeek`, `computeOrdersForWeek`) and the types it needs are copied
// verbatim from the client modules `src/logic/gameEngine.ts` and
// `src/logic/robotOrders.ts`, so that the authoritative round advancement can
// run in a Cloud Function instead of the host's browser.
//
// KEEP IN SYNC with src/logic/gameEngine.ts + src/logic/robotOrders.ts. These
// are intentionally duplicated (the functions package has its own tsconfig /
// rootDir and cannot import from ../src). The functions are pure — no Firebase,
// no React — so a straight copy is safe.

export type Role = "retailer" | "wholesaler" | "distributor" | "factory";

export const ROLES: Role[] = ["retailer", "wholesaler", "distributor", "factory"];

export interface GameConfig {
  nWeeks: number;
  inventoryCost: number;
  backlogCost: number;
  customerDemand: number[];
  extraOrderDelay: boolean;
  displayUpstreamBackorders?: boolean;
}

export interface OrdersForWeek {
  retailer: number;
  wholesaler: number;
  distributor: number;
  factory: number; // factory = production request
}

export interface WeekRecord {
  week: number;
  orderPlaced: number;
  demandThisWeek: number;
  shipped: number;
  inventoryEnd: number;
  backlogEnd: number;
  cost: number;
}

export interface StageRuntimeState {
  role: Role;
  playerId: string | null;
  playerName: string | null;
  isRobot: boolean;
  inventory: number;
  backlog: number;
  delay1: number;
  delay2: number;
  incomingOrder: number;
  history: WeekRecord[];
}

export interface TeamState {
  id: string;
  name: string;
  currentWeek: number;
  totalCost: number;
  stages: Record<Role, StageRuntimeState>;
  ordersSubmitted: Partial<Record<Role, boolean>>;
  pendingOrders: Partial<Record<Role, number>>;
  previousWeekOrders: OrdersForWeek;
  supplyChainCostHistory: number[];
  humanCount: number;
}

export type CostByRole = Record<Role, number>;

// ── Ported from src/logic/gameModel.ts (KEEP IN SYNC) ─────────────────────────
export function defaultConfig(): GameConfig {
  const nWeeks = 40;
  const customerDemand = Array.from({ length: nWeeks }, (_, i) => (i < 4 ? 4 : 8));
  return {
    nWeeks,
    inventoryCost: 0.5,
    backlogCost: 1.0,
    customerDemand,
    extraOrderDelay: false,
    displayUpstreamBackorders: false,
  };
}

function createStage(role: Role): StageRuntimeState {
  return {
    role,
    playerId: null,
    playerName: null,
    isRobot: false,
    inventory: 12,
    backlog: 0,
    delay1: 4,
    delay2: 4,
    incomingOrder: 4,
    history: [],
  };
}

export function createInitialTeamState(id: string, name: string): TeamState {
  return {
    id,
    name,
    currentWeek: 1,
    totalCost: 0,
    stages: {
      retailer: createStage("retailer"),
      wholesaler: createStage("wholesaler"),
      distributor: createStage("distributor"),
      factory: createStage("factory"),
    },
    ordersSubmitted: {},
    pendingOrders: {},
    previousWeekOrders: { retailer: 4, wholesaler: 4, distributor: 4, factory: 4 },
    supplyChainCostHistory: [],
    humanCount: 0,
  };
}

function createZeroCost(): CostByRole {
  return { retailer: 0, wholesaler: 0, distributor: 0, factory: 0 };
}

// ── Ported verbatim from src/logic/gameEngine.ts ──────────────────────────────
export function simulateWeek(
  prevTeam: TeamState,
  config: GameConfig,
  orders: OrdersForWeek
): { nextTeam: TeamState; costByRole: CostByRole } {
  const week = prevTeam.currentWeek;
  if (week > config.nWeeks) {
    return { nextTeam: prevTeam, costByRole: createZeroCost() };
  }

  const team: TeamState = JSON.parse(JSON.stringify(prevTeam));
  const costByRole: CostByRole = createZeroCost();
  const shipmentsOut: Record<Role, number> = {
    retailer: 0,
    wholesaler: 0,
    distributor: 0,
    factory: 0,
  };

  // 1) Receive shipments / production (Delay1 -> inventory, Delay2 -> Delay1)
  for (const role of ROLES) {
    const s = team.stages[role];
    s.inventory += s.delay1;
    s.delay1 = s.delay2;
    s.delay2 = 0;
  }

  // If extra delay is on, the demand comes from the orders placed two weeks ago.
  const demandSource = config.extraOrderDelay ? team.previousWeekOrders : orders;

  const lastDemandIndex = Math.max(0, config.customerDemand.length);
  const customerDemandIndex = Math.min(Math.max(0, week), lastDemandIndex);
  const nextCustomerDemandIndex = Math.min(Math.max(0, week), lastDemandIndex);
  const currentCustomerDemand =
    config.customerDemand[customerDemandIndex] ??
    config.customerDemand[lastDemandIndex] ??
    4;
  const nextCustomerDemand =
    config.customerDemand[nextCustomerDemandIndex] ?? currentCustomerDemand;

  for (const role of ROLES) {
    const s = team.stages[role];

    let baseDemand: number;
    if (role === "retailer") {
      baseDemand = currentCustomerDemand;
    } else if (role === "wholesaler") {
      baseDemand = demandSource.retailer;
    } else if (role === "distributor") {
      baseDemand = demandSource.wholesaler;
    } else {
      baseDemand = demandSource.distributor;
    }

    const totalDemand = baseDemand + s.backlog;
    const shipped = Math.min(s.inventory, totalDemand);
    shipmentsOut[role] = shipped;

    s.inventory -= shipped;
    s.backlog = totalDemand - shipped;

    const cost = config.inventoryCost * s.inventory + config.backlogCost * s.backlog;
    costByRole[role] = cost;

    s.history.push({
      week,
      orderPlaced: orders[role],
      demandThisWeek: baseDemand,
      shipped,
      inventoryEnd: s.inventory,
      backlogEnd: s.backlog,
      cost,
    });
  }

  // 3) Map shipments through shipping / production delays
  team.stages.retailer.delay2 += shipmentsOut.wholesaler;
  team.stages.wholesaler.delay2 += shipmentsOut.distributor;
  team.stages.distributor.delay2 += shipmentsOut.factory;
  team.stages.factory.delay2 = orders.factory;

  // 4) Record the orders seen this week (for UI)
  team.stages.retailer.incomingOrder = nextCustomerDemand;
  team.stages.wholesaler.incomingOrder = demandSource.retailer;
  team.stages.distributor.incomingOrder = demandSource.wholesaler;
  team.stages.factory.incomingOrder = demandSource.distributor;

  // 5) Costs aggregated over supply chain
  const totalWeekCost = ROLES.reduce((sum, r) => sum + costByRole[r], 0);
  team.totalCost += totalWeekCost;
  team.supplyChainCostHistory.push(totalWeekCost);

  team.currentWeek = week + 1;
  team.ordersSubmitted = {};
  team.previousWeekOrders = orders;

  return { nextTeam: team, costByRole };
}

// ── Ported verbatim from src/logic/robotOrders.ts ─────────────────────────────
export function computeOrdersForWeek(
  team: TeamState,
  config: GameConfig,
  partialOrders: Partial<Record<Role, number>> = {}
): Record<Role, number> {
  const orders: Record<Role, number> = {
    retailer: 0,
    wholesaler: 0,
    distributor: 0,
    factory: 0,
  };

  const week = team.currentWeek;

  for (const role of ROLES) {
    const stage = team.stages[role];

    if (!stage.isRobot) {
      const raw = partialOrders[role];
      const clean = typeof raw === "number" && !Number.isNaN(raw) ? raw : 0;
      orders[role] = Math.max(0, Math.round(clean));
      continue;
    }

    let baseDemand = 0;
    if (role === "retailer") {
      const demandIndex = Math.min(
        Math.max(0, week - 1),
        config.customerDemand.length - 1
      );
      baseDemand = stage.incomingOrder ?? config.customerDemand[demandIndex] ?? 0;
    } else {
      baseDemand = stage.incomingOrder ?? 0;
    }

    const jitterOptions = [-1, 0, 1];
    const idx = Math.floor(Math.random() * jitterOptions.length);
    let order = baseDemand + jitterOptions[idx];
    if (order < 0) order = 0;

    orders[role] = Math.round(order);
  }

  return orders;
}

/**
 * Readiness predicate — mirrors the host client loop (HostLobby.tsx): a team is
 * ready to advance when every NON-robot role has submitted this week (a team
 * with no human roles is always ready).
 */
export function teamIsReadyToAdvance(team: TeamState): boolean {
  const humanRoles = ROLES.filter((r) => !team.stages[r].isRobot);
  return humanRoles.every((r) => team.ordersSubmitted?.[r] === true);
}
