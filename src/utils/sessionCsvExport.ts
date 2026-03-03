import { strToU8, zipSync } from "fflate";
import { EndgameLeaderboardRow, TeamRoleStdDevRow } from "../logic/endgameAnalytics";
import { ROLES, TeamState } from "../logic/gameModel";

interface SessionCsvExportInput {
  gameCode: string;
  sessionData: Record<string, unknown>;
  teams: TeamState[];
  players: Array<{ id: string; data: Record<string, unknown> }>;
  leaderboardRows: EndgameLeaderboardRow[];
  stdDevRows: TeamRoleStdDevRow[];
}

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function hardenFormulaInjection(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function escapeCsv(value: unknown): string {
  const normalized = hardenFormulaInjection(normalizeCell(value));
  return `"${normalized.replace(/"/g, "\"\"")}"`;
}

function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map((cell) => escapeCsv(cell)).join(",")).join("\n");
}

function toIsoString(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const maybeTimestamp = value as {
    toDate?: () => Date;
    toMillis?: () => number;
    seconds?: number;
  };
  if (typeof maybeTimestamp.toDate === "function") {
    return maybeTimestamp.toDate().toISOString();
  }
  if (typeof maybeTimestamp.toMillis === "function") {
    return new Date(maybeTimestamp.toMillis()).toISOString();
  }
  if (typeof maybeTimestamp.seconds === "number") {
    return new Date(maybeTimestamp.seconds * 1000).toISOString();
  }
  return "";
}

function buildSessionCsv(input: SessionCsvExportInput): string {
  const config = (input.sessionData.config ?? {}) as Record<string, unknown>;
  const rows: unknown[][] = [
    [
      "game_code",
      "status",
      "created_at",
      "expires_at",
      "owner_instructor_id",
      "owner_instructor_email",
      "human_join_count",
      "notes",
      "config_n_weeks",
      "config_inventory_cost",
      "config_backlog_cost",
      "config_extra_order_delay",
      "config_display_upstream_backorders",
      "config_customer_demand",
    ],
    [
      input.gameCode,
      input.sessionData.status ?? "",
      toIsoString(input.sessionData.createdAt),
      toIsoString(input.sessionData.expiresAt),
      input.sessionData.ownerInstructorId ?? "",
      input.sessionData.ownerInstructorEmail ?? "",
      input.sessionData.humanJoinCount ?? "",
      input.sessionData.notes ?? "",
      config.nWeeks ?? "",
      config.inventoryCost ?? "",
      config.backlogCost ?? "",
      config.extraOrderDelay ?? "",
      config.displayUpstreamBackorders ?? "",
      Array.isArray(config.customerDemand) ? config.customerDemand.join(";") : "",
    ],
  ];
  return toCsv(rows);
}

function buildLeaderboardCsv(rows: EndgameLeaderboardRow[]): string {
  const table: unknown[][] = [["rank", "team_id", "team_name", "total_cost", "robot_count", "bullwhip"]];
  rows.forEach((row) => {
    table.push([
      row.rank,
      row.teamId,
      row.teamName,
      row.totalCost.toFixed(2),
      row.robotCount,
      row.bullwhip === null ? "N/A" : row.bullwhip.toFixed(6),
    ]);
  });
  return toCsv(table);
}

function buildStdDevCsv(rows: TeamRoleStdDevRow[]): string {
  const table: unknown[][] = [
    [
      "team_id",
      "team_name",
      "retailer_stddev",
      "wholesaler_stddev",
      "distributor_stddev",
      "factory_stddev",
    ],
  ];
  rows.forEach((row) => {
    table.push([
      row.teamId,
      row.teamName,
      row.retailerStdDev.toFixed(6),
      row.wholesalerStdDev.toFixed(6),
      row.distributorStdDev.toFixed(6),
      row.factoryStdDev.toFixed(6),
    ]);
  });
  return toCsv(table);
}

function buildTeamOrdersCsv(teams: TeamState[]): string {
  const table: unknown[][] = [
    [
      "team_id",
      "team_name",
      "role",
      "week",
      "order_placed",
      "demand_this_week",
      "shipped",
      "inventory_end",
      "backlog_end",
      "cost",
    ],
  ];

  teams.forEach((team) => {
    ROLES.forEach((role) => {
      team.stages[role].history.forEach((record) => {
        table.push([
          team.id,
          team.name,
          role,
          record.week,
          record.orderPlaced,
          record.demandThisWeek,
          record.shipped,
          record.inventoryEnd,
          record.backlogEnd,
          record.cost.toFixed(6),
        ]);
      });
    });
  });

  return toCsv(table);
}

function buildPlayersCsv(players: Array<{ id: string; data: Record<string, unknown> }>): string {
  const table: unknown[][] = [
    [
      "player_id",
      "name",
      "normalized_name",
      "team_id",
      "team_name",
      "role",
      "is_robot",
      "created_at",
      "last_heartbeat_at",
      "removed_at",
      "removed_by",
    ],
  ];

  players.forEach(({ id, data }) => {
    table.push([
      id,
      data.name ?? "",
      data.normalizedName ?? "",
      data.teamId ?? "",
      data.teamName ?? "",
      data.role ?? "",
      data.isRobot === true,
      toIsoString(data.createdAt),
      toIsoString(data.lastHeartbeatAt),
      toIsoString(data.removedAt),
      data.removedBy ?? "",
    ]);
  });

  return toCsv(table);
}

export function downloadSessionCsvBundle(input: SessionCsvExportInput): void {
  const files: Record<string, Uint8Array> = {
    "session.csv": strToU8(buildSessionCsv(input)),
    "leaderboard.csv": strToU8(buildLeaderboardCsv(input.leaderboardRows)),
    "team_role_stddev.csv": strToU8(buildStdDevCsv(input.stdDevRows)),
    "team_orders.csv": strToU8(buildTeamOrdersCsv(input.teams)),
    "players.csv": strToU8(buildPlayersCsv(input.players)),
  };

  const zipBytes = zipSync(files, { level: 6 });
  const blobBytes = new Uint8Array(zipBytes.byteLength);
  blobBytes.set(zipBytes);
  const blob = new Blob([blobBytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${input.gameCode}-session-data.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
