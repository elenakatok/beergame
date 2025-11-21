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

  // 2) Ship to meet demand + backlog
  for (const role of ROLES) {
    const s = team.stages[role];

    let baseDemand: number;
    if (role === "retailer") {
      const demandIndex = Math.min(week, config.customerDemand.length - 1);
      baseDemand = config.customerDemand[demandIndex];
    } else if (role === "wholesaler") {
      baseDemand = orders.retailer;
    } else if (role === "distributor") {
      baseDemand = orders.wholesaler;
    } else {
      // factory
      baseDemand = orders.distributor;
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
  team.stages.factory.delay2 += orders.factory;

  // 4) Record the orders seen this week (for UI)
  const demandIndex = Math.min(week - 1, config.customerDemand.length - 1);
  team.stages.retailer.incomingOrder = config.customerDemand[demandIndex];
  team.stages.wholesaler.incomingOrder = orders.retailer;
  team.stages.distributor.incomingOrder = orders.wholesaler;
  team.stages.factory.incomingOrder = orders.distributor;

  // 5) Costs aggregated over supply chain
  const totalWeekCost = ROLES.reduce(
    (sum, r) => sum + costByRole[r],
    0
  );
  team.totalCost += totalWeekCost;
  team.supplyChainCostHistory.push(totalWeekCost);

  team.currentWeek = week + 1;
  team.ordersSubmitted = {};
  team.pendingOrders = {};

  return { nextTeam: team, costByRole };
}
