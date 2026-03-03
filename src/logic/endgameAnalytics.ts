import { ROLES, Role, TeamState } from "./gameModel";

export interface EndgameLeaderboardRow {
  rank: number;
  teamId: string;
  teamName: string;
  totalCost: number;
  robotCount: number;
  bullwhip: number | null;
}

export interface TeamRoleStdDevRow {
  teamId: string;
  teamName: string;
  retailerStdDev: number;
  wholesalerStdDev: number;
  distributorStdDev: number;
  factoryStdDev: number;
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sortTeamsForReporting(teams: TeamState[]): TeamState[] {
  return [...teams].sort((a, b) => {
    const byCost = toFiniteNumber(a.totalCost) - toFiniteNumber(b.totalCost);
    if (byCost !== 0) return byCost;
    return a.name.localeCompare(b.name);
  });
}

export function getRoleOrderSeries(team: TeamState, role: Role): number[] {
  const history = team.stages[role]?.history ?? [];
  return history.map((row) => Math.max(0, toFiniteNumber(row.orderPlaced)));
}

export function populationVariance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

export function standardDeviation(values: number[]): number {
  return Math.sqrt(populationVariance(values));
}

export function computeBullwhip(team: TeamState): number | null {
  const factoryVariance = populationVariance(getRoleOrderSeries(team, "factory"));
  const retailerVariance = populationVariance(getRoleOrderSeries(team, "retailer"));
  if (retailerVariance === 0) return null;
  return factoryVariance / retailerVariance;
}

export function countRobotsAtEnd(team: TeamState): number {
  return ROLES.reduce((count, role) => (team.stages[role]?.isRobot ? count + 1 : count), 0);
}

export function buildLeaderboardRows(teams: TeamState[]): EndgameLeaderboardRow[] {
  return sortTeamsForReporting(teams).map((team, index) => ({
    rank: index + 1,
    teamId: team.id,
    teamName: team.name,
    totalCost: toFiniteNumber(team.totalCost),
    robotCount: countRobotsAtEnd(team),
    bullwhip: computeBullwhip(team),
  }));
}

export function buildStdDevRows(teams: TeamState[]): TeamRoleStdDevRow[] {
  return sortTeamsForReporting(teams).map((team) => {
    const byRole = Object.fromEntries(
      ROLES.map((role) => [role, standardDeviation(getRoleOrderSeries(team, role))])
    ) as Record<Role, number>;
    return {
      teamId: team.id,
      teamName: team.name,
      retailerStdDev: byRole.retailer,
      wholesalerStdDev: byRole.wholesaler,
      distributorStdDev: byRole.distributor,
      factoryStdDev: byRole.factory,
    };
  });
}
