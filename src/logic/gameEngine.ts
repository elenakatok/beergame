// src/logic/gameEngine.ts
import { GameConfig, TeamState, Role, ROLES } from "./gameModel";

export interface OrdersForWeek {
  retailer: number;
  wholesaler: number;
  distributor: number;
  factory: number; // factory = production request
}

export type CostByRole = Record<Role, number>;

function createZeroCost(): CostByRole {
  return {
    retailer: 0,
    wholesaler: 0,
    distributor: 0,
    factory: 0,
  };
}

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

  // 2) Ship to meet demand + backlog
  // The week is 1-based, the array is 0-based.
  // For week 1, we need index 0. For week 5, we need index 4.
  // Clamp to the last known demand value so we don't silently fall back to 4
  const lastDemandIndex = Math.max(0, config.customerDemand.length);
  const customerDemandIndex = Math.min(
    Math.max(0, week),
    lastDemandIndex
  );
  const nextCustomerDemandIndex = Math.min(
    Math.max(0, week), // next week (week is 1-based)
    lastDemandIndex
  );
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
      // factory
      baseDemand = demandSource.distributor;
    }

    const totalDemand = baseDemand + s.backlog;
    const shipped = Math.min(s.inventory, totalDemand);
    shipmentsOut[role] = shipped;

    s.inventory -= shipped;
    s.backlog = totalDemand - shipped;

    const cost =
      config.inventoryCost * s.inventory +
      config.backlogCost * s.backlog;

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
  // Shipments sent this week move into delay2 of the downstream stage.
  team.stages.retailer.delay2 += shipmentsOut.wholesaler;
  team.stages.wholesaler.delay2 += shipmentsOut.distributor;
  team.stages.distributor.delay2 += shipmentsOut.factory;

  // Factory's delay2 is production (what will enter its own inventory after 2 weeks)
  team.stages.factory.delay2 = orders.factory;

  // 4) Record the orders seen this week (for UI)
  // Retailer can know next week's exogenous demand up front; store it so the UI shows
  // the demand that will be fulfilled in the upcoming week (avoids off-by-one display).
  team.stages.retailer.incomingOrder = nextCustomerDemand;
  team.stages.wholesaler.incomingOrder = demandSource.retailer;
  team.stages.distributor.incomingOrder = demandSource.wholesaler;
  team.stages.factory.incomingOrder = demandSource.distributor;

  // 5) Costs aggregated over supply chain
  const totalWeekCost = ROLES.reduce(
    (sum, r) => sum + costByRole[r],
    0
  );
  team.totalCost += totalWeekCost;
  team.supplyChainCostHistory.push(totalWeekCost);

  team.currentWeek = week + 1;
  team.ordersSubmitted = {};
  // The orders from this turn (t-1) become the previous week's orders for the next turn (t+1)
  team.previousWeekOrders = orders;

  return { nextTeam: team, costByRole };
}
