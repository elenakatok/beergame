// src/logic/robotOrders.ts
import { GameConfig, Role, TeamState, ROLES } from "./gameModel";

/**
 * Combine human orders (partialOrders) with robot orders for all four roles.
 * - Human stages: use the submitted order as-is (sanitized to a non-negative int).
 * - Robot stages: order = baseDemand + {-1, 0, +1} with equal probabilities.
 *
 * baseDemand:
 *   - retailer: exogenous customer demand for this week
 *   - others:   incomingOrder field on that stage for this week
 */
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

    // If this is a human stage, just use their order (should always be present
    // once the host auto-advance triggers).
    if (!stage.isRobot) {
      const raw = (partialOrders as any)[role];
      const clean =
        typeof raw === "number" && !Number.isNaN(raw) ? raw : 0;
      orders[role] = Math.max(0, Math.round(clean));
      continue;
    }

    // Robot behavior: base on observed demand, then add a small random jitter
    let baseDemand = 0;

    if (role === "retailer") {
      // Retailer robots see the same exogenous demand as human retailers.
      const demandIndex = Math.min(
        Math.max(0, week - 1),
        config.customerDemand.length - 1
      );
      baseDemand = config.customerDemand[demandIndex] ?? 0;
    } else {
      // Upstream robots see the incoming order from their downstream partner.
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
