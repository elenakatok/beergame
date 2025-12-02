// src/components/HostLobby.tsx
import React, { useEffect, useState } from "react";
import { db } from "../firebase";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import {
  defaultConfig,
  GameConfig,
  Role,
  TeamState,
  ROLES,
  createInitialTeamState,
} from "../logic/gameModel";
import { computeOrdersForWeek } from "../logic/robotOrders";
import { simulateWeek } from "../logic/gameEngine";
import { BEER_TEAM_NAMES } from "../logic/teamNames";

const HOST_GAME_CODE_KEY = "beerGame_host_gameCode";
const HOST_SECRET_KEY = "beerGame_host_hostSecret";

interface LobbyPlayer {
  id: string;
  name: string;
}

const HostLobby: React.FC = () => {
  const [hostSecret, setHostSecret] = useState("");
  const [hostAuthed, setHostAuthed] = useState(false);
  const [gameCode, setGameCode] = useState<string | null>(null);
  const [gameStatus, setGameStatus] = useState<
    "lobby" | "in_progress" | "ended" | null
  >(null);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<GameConfig>(defaultConfig());
  const [editingSettings, setEditingSettings] = useState(false);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [teams, setTeams] = useState<TeamState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Reattach host session (only when user is on Host view)
  useEffect(() => {
    const storedSecret = localStorage.getItem(HOST_SECRET_KEY);
    const storedCode = localStorage.getItem(HOST_GAME_CODE_KEY);
    if (storedSecret === "Sesame" && storedCode) {
      setHostAuthed(true);
      setGameCode(storedCode);
    }
  }, []);

  // Subscribe to game doc
  useEffect(() => {
    if (!gameCode) return;
    const gameRef = doc(db, "games", gameCode);
    const unsub = onSnapshot(
      gameRef,
      (snap) => {
        if (!snap.exists()) {
          // Game was deleted, clear stored code and ask to create new session
          setError("Game not found. Creating a new session…");
          setGameStatus(null);
          setConfig(null);
          localStorage.removeItem(HOST_GAME_CODE_KEY);
          setGameCode(null);
          return;
        }
        const data = snap.data() as any;
        setGameStatus(data.status);
        const cfg = data.config as GameConfig;
        setConfig(cfg);
        if (cfg) {
          setConfigDraft(cfg);
        }
      },
      (err) => {
        console.error("Error subscribing to game:", err);
        setError("Error loading game.");
      }
    );
    return unsub;
  }, [gameCode]);

  // If host is authed but there is no active game, auto-create one
  useEffect(() => {
    if (hostAuthed && !gameCode && !creating) {
      createNewGame();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostAuthed, gameCode, creating]);

  // Lobby players
  useEffect(() => {
    if (!gameCode || gameStatus !== "lobby") {
      setPlayers([]);
      return;
    }
    const playersRef = collection(db, "games", gameCode, "players");
    const q = query(playersRef, orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      const arr: LobbyPlayer[] = snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          id: d.id,
          name: data.name,
        };
      });
      setPlayers(arr);
    });
    return unsub;
  }, [gameCode, gameStatus]);

  // Teams during / after game
  useEffect(() => {
    if (!gameCode || !config || gameStatus === "lobby" || !gameStatus) {
      setTeams([]);
      return;
    }
    const teamsRef = collection(db, "games", gameCode, "teams");
    const unsub = onSnapshot(teamsRef, (snap) => {
      const arr: TeamState[] = snap.docs.map((d) => {
        const data = d.data() as any;
        const totalCost =
          typeof data.totalCost === "number" ? data.totalCost : 0;
        const humanCount =
          typeof data.humanCount === "number" ? data.humanCount : 0;

        return {
          ...(data as TeamState),
          id: data.id ?? d.id,
          totalCost,
          humanCount,
        };
      });
      setTeams(arr);
    });
    return unsub;
  }, [gameCode, config, gameStatus]);

  // Auto-advance teams once all human orders submitted
  useEffect(() => {
    if (!gameCode || !config || gameStatus !== "in_progress") return;
    if (!teams || teams.length === 0) return;

    const advance = async () => {
      for (const team of teams) {
        if (!team) continue;
        if (team.currentWeek > config.nWeeks) continue;

        const rolesToWaitFor = ROLES.filter(
          (r) => !team.stages[r].isRobot
        );
        const allSubmitted =
          rolesToWaitFor.length === 0 ||
          rolesToWaitFor.every(
            (r) => team.ordersSubmitted && team.ordersSubmitted[r]
          );
        if (!allSubmitted) continue;

        const teamRef = doc(db, "games", gameCode, "teams", team.id);
        const partialOrders = (team.pendingOrders || {}) as any;

        try {
          const orders = computeOrdersForWeek(
            team,
            config,
            partialOrders
          );
          const { nextTeam } = simulateWeek(team, config, orders);
          nextTeam.pendingOrders = {};
          nextTeam.ordersSubmitted = {};
          await setDoc(teamRef, nextTeam);
        } catch (err) {
          console.error("Failed to advance team", team.id, err);
        }
      }
    };

    advance();
  }, [gameCode, config, gameStatus, teams]);

  const handleHostLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (hostSecret !== "Sesame") {
      setError("Incorrect host password.");
      return;
    }
    localStorage.setItem(HOST_SECRET_KEY, hostSecret);
    setHostAuthed(true);

    const storedCode = localStorage.getItem(HOST_GAME_CODE_KEY);
    if (storedCode) {
      setGameCode(storedCode);
      return;
    }
    await createNewGame();
  };

  const createNewGame = async () => {
    try {
      setCreating(true);
      setError(null);
      const code = generateGameCode(4);
      const gameRef = doc(db, "games", code);
      const cfg = sanitizeConfig(configDraft || defaultConfig());
      await setDoc(gameRef, {
        status: "lobby",
        createdAt: serverTimestamp(),
        config: cfg,
      });
      localStorage.setItem(HOST_GAME_CODE_KEY, code);
      setGameCode(code);
      setConfig(cfg);
      setConfigDraft(cfg);
    } catch (err) {
      console.error(err);
      setError("Failed to create a new game.");
    } finally {
      setCreating(false);
    }
  };

  const handleRemovePlayer = async (playerId: string) => {
    if (!gameCode) return;
    const ref = doc(db, "games", gameCode, "players", playerId);
    await deleteDoc(ref);
  };

  const sanitizeConfig = (cfg: GameConfig): GameConfig => {
    const nWeeks = Math.max(1, Math.round(cfg.nWeeks));
    const inventoryCost = Math.max(0, Number(cfg.inventoryCost) || 0);
    const backlogCost = Math.max(0, Number(cfg.backlogCost) || 0);
    return {
      ...cfg,
      nWeeks,
      inventoryCost,
      backlogCost,
      customerDemand: cfg.customerDemand,
    };
  };

  const handleSaveConfig = async () => {
    if (!gameCode) return;
    const nextCfg = sanitizeConfig(configDraft);
    const gameRef = doc(db, "games", gameCode);
    await updateDoc(gameRef, { config: nextCfg });
    setConfig(nextCfg);
    setConfigDraft(nextCfg);
    setEditingSettings(false);
  };

  const handleBeginEdit = () => {
    setConfigDraft(config || defaultConfig());
    setEditingSettings(true);
  };

  const handleCancelEdit = () => {
    setConfigDraft(config || defaultConfig());
    setEditingSettings(false);
  };

  const handleDownloadPlayers = async () => {
    if (!gameCode) return;
    try {
      const playersRef = collection(db, "games", gameCode, "players");
      const snap = await getDocs(playersRef);
      if (snap.empty) {
        alert("No players found for this session.");
        return;
      }

      const rows: string[][] = [
        ["name", "teamId", "teamName", "role", "isRobot"],
      ];

      snap.forEach((d) => {
        const data = d.data() as any;
        rows.push([
          data.name ?? "",
          data.teamId ?? "",
          data.teamName ?? "",
          data.role ?? "",
          String(data.isRobot ?? false),
        ]);
      });

      const escape = (val: string) => {
        const s = `${val ?? ""}`;
        if (s.includes('"') || s.includes(",") || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      const csv = rows.map((r) => r.map(escape).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `beer-game-players-${gameCode}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export players", err);
      alert("Failed to export player list.");
    }
  };

  const handleKickToRobot = async (teamId: string, role: Role) => {
    if (!gameCode) return;
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;
    const stage = team.stages[role];
    if (!stage || stage.isRobot) return;

    const playerLabel = stage.playerName || "this player";
    const confirmed = window.confirm(
      `Remove ${playerLabel} from ${team.name} (${role}) and replace with a robot?`
    );
    if (!confirmed) return;

    const teamRef = doc(db, "games", gameCode, "teams", teamId);
    const updates: Record<string, any> = {
      [`stages.${role}.playerId`]: null,
      [`stages.${role}.playerName`]: "Beer GPT",
      [`stages.${role}.isRobot`]: true,
      humanCount: Math.max(0, (team.humanCount ?? 0) - 1),
    };

    await updateDoc(teamRef, updates);

    if (stage.playerId) {
      const playerRef = doc(
        db,
        "games",
        gameCode,
        "players",
        stage.playerId
      );
      await deleteDoc(playerRef);
    }
  };

  const handleStartGame = async () => {
    if (!gameCode || !config) return;
    if (players.length === 0) {
      alert("At least one player is required to start the game.");
      return;
    }

    try {
      await handleSaveConfig();
      const gameRef = doc(db, "games", gameCode);
      const playersRef = collection(gameRef, "players");
      const snap = await getDocs(playersRef);
      const allPlayers = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));

      if (allPlayers.length === 0) {
        alert("No players found.");
        return;
      }

      // Shuffle all humans
      const shuffled = [...allPlayers].sort(
        () => Math.random() - 0.5
      );

      const numTeams = Math.ceil(shuffled.length / 4);

      // Distribute humans as evenly as possible across teams
      const baseHumansPerTeam = Math.floor(shuffled.length / numTeams);
      const remainderHumans = shuffled.length % numTeams;

      const roles: Role[] = [
        "retailer",
        "wholesaler",
        "distributor",
        "factory",
      ];

      // Prefer robots in earlier stages to match your example
      // (with 6 players -> 2 teams, robot retailer on each team).
      const ROBOT_ROLE_PRIORITY: Role[] = [
        "retailer",
        "wholesaler",
        "distributor",
        "factory",
      ];

      const batch = writeBatch(db);
      const usedNames = new Set<string>();
      let playerIndex = 0;

      for (let i = 0; i < numTeams; i++) {
        const teamId = `team${i + 1}`;
        const teamName = pickTeamName(i, usedNames);
        let team = createInitialTeamState(teamId, teamName);

        // How many humans and robots on this team?
        const humansThisTeam =
          baseHumansPerTeam + (i < remainderHumans ? 1 : 0);
        const robotsThisTeam = Math.max(0, roles.length - humansThisTeam);

        const teamPlayers = shuffled.slice(
          playerIndex,
          playerIndex + humansThisTeam
        );
        playerIndex += humansThisTeam;

        let robotRoles: Role[] = [];
        let humanRoles: Role[] = [];

        if (robotsThisTeam === 0) {
          // All roles are human
          humanRoles = [...roles];
        } else {
          // Assign robots to preferred roles first (e.g., retailer)
          robotRoles = ROBOT_ROLE_PRIORITY.slice(0, robotsThisTeam);
          humanRoles = roles.filter((r) => !robotRoles.includes(r));
        }

        // Randomly assign humans to remaining roles
        const shuffledHumans = [...teamPlayers].sort(
          () => Math.random() - 0.5
        );

        shuffledHumans.forEach((player, idx) => {
          const role = humanRoles[idx];
          if (!role) return;

          team.stages[role].playerId = player.id;
          team.stages[role].playerName = player.name;
          team.stages[role].isRobot = false;
          team.humanCount += 1;

          const playerRef = doc(
            db,
            "games",
            gameCode,
            "players",
            player.id
          );
          batch.update(playerRef, {
            teamId,
            role,
            isRobot: false,
            teamName,
          });
        });

        // Fill remaining roles with robots
        robotRoles.forEach((role) => {
          team.stages[role].playerId = null;
          team.stages[role].playerName = "Beer GPT";
          team.stages[role].isRobot = true;
        });

        const teamRef = doc(
          db,
          "games",
          gameCode,
          "teams",
          teamId
        );
        batch.set(teamRef, team);
      }

      batch.update(gameRef, { status: "in_progress" });
      await batch.commit();
    } catch (err) {
      console.error(err);
      setError("Failed to start game.");
    }
  };

  const handleEndSession = async () => {
    if (!gameCode) return;
    const gameRef = doc(db, "games", gameCode);
    await updateDoc(gameRef, { status: "ended" });
  };

  const handleNewSession = async () => {
    localStorage.removeItem(HOST_GAME_CODE_KEY);
    setGameCode(null);
    await createNewGame();
  };

  if (!hostAuthed) {
    return (
      <div style={{ maxWidth: 480 }}>
        <h2>Host Login</h2>
        <p>Enter the instructor password to access the host view.</p>
        <form
          onSubmit={handleHostLogin}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            marginTop: "0.5rem",
          }}
        >
          <input
            type="password"
            value={hostSecret}
            onChange={(e) => setHostSecret(e.target.value)}
            placeholder="Host password"
          />
          <button type="submit" disabled={creating}>
            {creating ? "Creating game..." : "Enter Host View"}
          </button>
          {error && (
            <div style={{ color: "red", fontSize: "0.9rem" }}>{error}</div>
          )}
        </form>
      </div>
    );
  }

  if (!gameCode || !config) {
    return (
      <div>
        <h2>Host View</h2>
        <p>Setting up session…</p>
        {error && (
          <div style={{ color: "red", fontSize: "0.9rem" }}>{error}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h2>Host View</h2>
      <div
        style={{
          padding: "0.75rem 1rem",
          borderRadius: "0.75rem",
          border: "1px solid #ddd",
          background: "#faf6e9",
        }}
      >
        <div>
          <strong>Game ID:</strong>{" "}
          <span style={{ fontFamily: "monospace", fontSize: "1.1rem" }}>
            {gameCode}
          </span>
        </div>
        <div>
          <strong>Status:</strong> {gameStatus}
        </div>
        <div>
          <strong>Config:</strong> {config.nWeeks} weeks, inventory cost $
          {config.inventoryCost.toFixed(2)}, backlog cost $
          {config.backlogCost.toFixed(2)}
        </div>
        <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
          {gameStatus === "lobby" && (
            <button onClick={handleStartGame} disabled={players.length === 0}>
              Start game
            </button>
          )}
          {gameStatus !== "ended" && (
            <button onClick={handleEndSession}>End session</button>
          )}
          {gameStatus === "ended" && (
            <button onClick={handleNewSession}>New session</button>
          )}
        </div>
      </div>

      {gameStatus === "lobby" && (
        <div
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "0.75rem",
            border: "1px solid #ddd",
          }}
        >
          <h3>Lobby</h3>
          <p>Share the Game ID above with students so they can join.</p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "0.75rem",
              margin: "0.75rem 0",
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: "0.85rem", color: "#444" }}>
                Number of rounds
              </span>
              <input
                type="number"
                min={1}
                value={configDraft.nWeeks}
                disabled={!editingSettings}
                onChange={(e) =>
                  setConfigDraft((prev) => ({
                    ...prev,
                    nWeeks: parseInt(e.target.value, 10) || 0,
                  }))
                }
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: "0.85rem", color: "#444" }}>
                Holding cost (per unit)
              </span>
              <input
                type="number"
                min={0}
                step="0.1"
                value={configDraft.inventoryCost}
                disabled={!editingSettings}
                onChange={(e) =>
                  setConfigDraft((prev) => ({
                    ...prev,
                    inventoryCost: parseFloat(e.target.value) || 0,
                  }))
                }
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: "0.85rem", color: "#444" }}>
                Backlog cost (per unit)
              </span>
              <input
                type="number"
                min={0}
                step="0.1"
                value={configDraft.backlogCost}
                disabled={!editingSettings}
                onChange={(e) =>
                  setConfigDraft((prev) => ({
                    ...prev,
                    backlogCost: parseFloat(e.target.value) || 0,
                  }))
                }
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
            {!editingSettings ? (
              <button onClick={handleBeginEdit}>Edit settings</button>
            ) : (
              <>
                <button onClick={handleSaveConfig}>Save session settings</button>
                <button onClick={handleCancelEdit}>Cancel</button>
              </>
            )}
          </div>
          {players.length === 0 ? (
            <p>No players have joined yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0 }}>
              {players.map((p) => (
                <li
                  key={p.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "0.25rem 0",
                  }}
                >
                  <span>{p.name}</span>
                  <button
                    onClick={() => handleRemovePlayer(p.id)}
                    style={{ fontSize: "0.8rem" }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {gameStatus === "in_progress" && (
        <div
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "0.75rem",
            border: "1px solid #ddd",
          }}
        >
          <h3>Teams overview</h3>
          {teams.length === 0 ? (
            <p>Waiting for teams to load…</p>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem",
              }}
            >
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Team</th>
                  <th>Week</th>
                  <th>Total cost</th>
                  <th>Retailer</th>
                  <th>Wholesaler</th>
                  <th>Distributor</th>
                  <th>Factory</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => {
                  const totalCost =
                    typeof t.totalCost === "number" ? t.totalCost : 0;
                  return (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td style={{ textAlign: "center" }}>{t.currentWeek}</td>
                      <td style={{ textAlign: "center" }}>
                        ${totalCost.toFixed(2)}
                      </td>
                      {ROLES.map((r) => {
                        const stage = t.stages[r];
                        const isRobot = stage.isRobot;
                        const submitted =
                          t.ordersSubmitted && t.ordersSubmitted[r];
                        return (
                          <td
                            key={r}
                            style={{
                              textAlign: "center",
                              padding: "0.1rem 0.25rem",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: "0.15rem",
                              }}
                            >
                              <span
                                style={{
                                  fontSize: "0.75rem",
                                  opacity: isRobot ? 0.7 : 1,
                                }}
                              >
                                {stage.playerName || "Beer GPT"}
                              </span>
                              <span>
                                {isRobot ? "🤖" : submitted ? "✅" : "⌛"}
                              </span>
                              {!isRobot && (
                                <button
                                  onClick={() => handleKickToRobot(t.id, r)}
                                  style={{
                                    fontSize: "0.7rem",
                                    padding: "0.15rem 0.4rem",
                                    borderRadius: "0.4rem",
                                  }}
                                >
                                  Kick to robot
                                </button>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {gameStatus === "ended" && (
        <div
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "0.75rem",
            border: "1px solid #ddd",
          }}
        >
          <h3>Leaderboard</h3>
          <div style={{ marginBottom: "0.5rem" }}>
            <button onClick={handleDownloadPlayers}>Download player list (CSV)</button>
          </div>
          {teams.length === 0 ? (
            <p>No teams found.</p>
          ) : (
            <>
              <ol>
                {teams
                  .slice()
                  .sort(
                    (a, b) =>
                      ((a.totalCost as number) ?? 0) -
                      ((b.totalCost as number) ?? 0)
                  )
                  .map((t) => {
                    const totalCost =
                      typeof t.totalCost === "number" ? t.totalCost : 0;
                    const humans =
                      typeof t.humanCount === "number" ? t.humanCount : 0;

                    return (
                      <li key={t.id}>
                        <strong>{t.name}</strong> — total cost $
                        {totalCost.toFixed(2)} (players: {humans}, robots:{" "}
                        {4 - humans})
                      </li>
                    );
                  })}
              </ol>

              <h4 style={{ marginTop: "1rem" }}>Order histories</h4>
              {teams.map((t) => (
                <div
                  key={t.id}
                  style={{
                    marginTop: "0.75rem",
                    paddingTop: "0.5rem",
                    borderTop: "1px solid #eee",
                    fontSize: "0.8rem",
                  }}
                >
                  <div
                    style={{
                      marginBottom: "0.25rem",
                      fontWeight: 600,
                    }}
                  >
                    {t.name}
                  </div>
                  <TeamOrdersChart team={t} />
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {error && (
        <div style={{ color: "red", fontSize: "0.9rem" }}>{error}</div>
      )}
    </div>
  );
};

// --- Simple SVG line chart for per-team order histories ---

const ROLE_COLORS: Record<Role, string> = {
  retailer: "#d73027",
  wholesaler: "#4575b4",
  distributor: "#1a9850",
  factory: "#984ea3",
};

interface TeamOrdersChartProps {
  team: TeamState;
}

const TeamOrdersChart: React.FC<TeamOrdersChartProps> = ({ team }) => {
  const series = ROLES.map((role) => ({
    role,
    label: role.charAt(0).toUpperCase() + role.slice(1),
    values: (team.stages[role].history || []).map(
      (h) => h.orderPlaced ?? 0
    ),
  }));

  const maxWeeks = series.reduce(
    (max, s) => Math.max(max, s.values.length),
    1
  );

  // Standardized y-axis for all teams
  const maxVal = 25;

  const width = 360;
  const height = 160;
  const paddingLeft = 32;
  const paddingRight = 10;
  const paddingTop = 10;
  const paddingBottom = 24;

  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const getX = (weekIndex: number) => {
    if (maxWeeks <= 1) {
      return paddingLeft + plotWidth / 2;
    }
    const t = weekIndex / (maxWeeks - 1);
    return paddingLeft + t * plotWidth;
  };

  const getY = (value: number) => {
    const val = Math.max(value, 0); // allow values > maxVal to go above chart
    const t = val / maxVal;
    return paddingTop + (1 - t) * plotHeight;
  };

  return (
    <div>
      <svg width={width} height={height}>
        {/* Axes */}
        <line
          x1={paddingLeft}
          y1={height - paddingBottom}
          x2={width - paddingRight}
          y2={height - paddingBottom}
          stroke="#aaa"
          strokeWidth={0.5}
        />
        <line
          x1={paddingLeft}
          y1={paddingTop}
          x2={paddingLeft}
          y2={height - paddingBottom}
          stroke="#aaa"
          strokeWidth={0.5}
        />

        {/* Y-axis labels (0 and max) */}
        <text
          x={paddingLeft - 6}
          y={height - paddingBottom + 10}
          fontSize={9}
          textAnchor="end"
          fill="#555"
        >
          0
        </text>
        <text
          x={paddingLeft - 6}
          y={paddingTop + 3}
          fontSize={9}
          textAnchor="end"
          fill="#555"
        >
          {maxVal}
        </text>

        {/* X-axis labels: week 1 and last week */}
        <text
          x={getX(0)}
          y={height - 6}
          fontSize={9}
          textAnchor="middle"
          fill="#555"
        >
          1
        </text>
        <text
          x={getX(maxWeeks - 1)}
          y={height - 6}
          fontSize={9}
          textAnchor="middle"
          fill="#555"
        >
          {maxWeeks}
        </text>

        {/* Lines per role */}
        {series.map((s) => {
          if (s.values.length === 0) return null;
          const d = s.values
            .map((v, idx) => {
              const x = getX(idx);
              const y = getY(v);
              return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
            })
            .join(" ");
          return (
            <path
              key={s.role}
              d={d}
              fill="none"
              stroke={ROLE_COLORS[s.role]}
              strokeWidth={1.5}
            />
          );
        })}

        {/* Small circles on points */}
        {series.map((s) =>
          s.values.map((v, idx) => {
            const x = getX(idx);
            const y = getY(v);
            return (
              <circle
                key={`${s.role}-${idx}`}
                cx={x}
                cy={y}
                r={2}
                fill={ROLE_COLORS[s.role]}
              />
            );
          })
        )}
      </svg>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          marginTop: "0.25rem",
          fontSize: "0.75rem",
        }}
      >
        {series.map((s) => (
          <div
            key={s.role}
            style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
          >
            <span
              style={{
                width: 10,
                height: 3,
                borderRadius: 2,
                backgroundColor: ROLE_COLORS[s.role],
                display: "inline-block",
              }}
            />
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

function generateGameCode(length: number): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function pickTeamName(index: number, used: Set<string>): string {
  // Choose a random unused name from the list
  const available = BEER_TEAM_NAMES.filter((name) => !used.has(name));
  let chosen: string;

  if (available.length > 0) {
    chosen = available[Math.floor(Math.random() * available.length)];
  } else {
    // All names used: fall back to reusing names with a numeric suffix
    const base = BEER_TEAM_NAMES[index % BEER_TEAM_NAMES.length];
    let suffix = 2;
    chosen = `${base} ${suffix}`;
    while (used.has(chosen)) {
      suffix += 1;
      chosen = `${base} ${suffix}`;
    }
  }

  used.add(chosen);
  return chosen;
}

export default HostLobby;
