// src/logic/gameModel.ts

import { OrdersForWeek } from "./gameEngine";
export type Role = "retailer" | "wholesaler" | "distributor" | "factory";

export const ROLES: Role[] = [
  "retailer",
  "wholesaler",
  "distributor",
  "factory",
];

export interface GameConfig {
  nWeeks: number;
  inventoryCost: number;
  backlogCost: number;
  customerDemand: number[];
  extraOrderDelay: boolean;
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

export interface StageState {
  role: Role;
  inventory: number;
  backlog: number;
  delay1: number;
  delay2: number;
  incomingOrder: number;
  history: WeekRecord[];
}

export interface StageRuntimeState extends StageState {
  playerId: string | null;
  playerName: string | null;
  isRobot: boolean;
}

export interface TeamState {
  id: string;
  name: string;
  currentWeek: number;
  totalCost: number;
  stages: Record<Role, StageRuntimeState>;
  // who has submitted in this week
  ordersSubmitted: Partial<Record<Role, boolean>>;
  // orders for this week (humans only; robots are derived)
  pendingOrders: Partial<Record<Role, number>>;
  // orders from the PREVIOUS week, used for extra delay
  previousWeekOrders: OrdersForWeek;
  // per-week total supply-chain cost
  supplyChainCostHistory: number[];
  // number of human players on the team
  humanCount: number;
}

export function defaultConfig(): GameConfig {
  const nWeeks = 40;
  const customerDemand = Array.from({ length: nWeeks }, (_, i) =>
    i < 4 ? 4 : 8
  );
  return {
    nWeeks,
    inventoryCost: 0.5,
    backlogCost: 1.0,
    customerDemand,
    extraOrderDelay: false,
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
    previousWeekOrders: {
      retailer: 4,
      wholesaler: 4,
      distributor: 4,
      factory: 4,
    },
    supplyChainCostHistory: [],
    humanCount: 0,
  };
}
