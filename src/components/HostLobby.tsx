import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  updateDoc,
  where,
  writeBatch,
  deleteField,
} from "firebase/firestore";
import { db } from "../firebase";
import { createSession, deleteSession } from "../api";
import {
  defaultConfig,
  GameConfig,
  Role,
  ROLES,
  TeamState,
  createInitialTeamState,
} from "../logic/gameModel";
import { computeOrdersForWeek } from "../logic/robotOrders";
import { simulateWeek } from "../logic/gameEngine";
import { BEER_TEAM_NAMES } from "../logic/teamNames";
import TeamOrdersLineChart from "./charts/TeamOrdersLineChart";
import TeamRoleStdDevGroupedBarChart from "./charts/TeamRoleStdDevGroupedBarChart";
import { buildLeaderboardRows, buildStdDevRows } from "../logic/endgameAnalytics";
import { downloadSessionCsvBundle } from "../utils/sessionCsvExport";
import { exportElementToPdf } from "../utils/exportPdf";

const HOST_GAME_CODE_KEY = "beerGame_host_gameCode";
const ONLINE_THRESHOLD_MS = 90_000;

interface Props {
  userUid: string;
  instructorEmail: string;
  isAdmin: boolean;
}

interface LobbyPlayer {
  id: string;
  name: string;
  normalizedName: string;
  lastHeartbeatAtMs: number | null;
}

interface SessionLite {
  id: string;
  status: "lobby" | "in_progress" | "ended";
  createdAtMs: number;
  ownerInstructorEmail?: string;
}

type SessionStatusFilter = "all" | SessionLite["status"];
type FeedbackTone = "success" | "error";

const HostLobby: React.FC<Props> = ({ userUid, instructorEmail, isAdmin }) => {
  const [gameCode, setGameCode] = useState<string | null>(null);
  const [gameStatus, setGameStatus] = useState<"lobby" | "in_progress" | "ended" | null>(null);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [configDraft, setConfigDraft] = useState(defaultConfig());
  const [savedNotes, setSavedNotes] = useState("");
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [teams, setTeams] = useState<TeamState[]>([]);
  const [sessions, setSessions] = useState<SessionLite[]>([]);
  const [notes, setNotes] = useState("");
  const [feedback, setFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionFilter, setSessionFilter] = useState<SessionStatusFilter>("all");
  const [kickingRoleKey, setKickingRoleKey] = useState<string | null>(null);
  const [csvExporting, setCsvExporting] = useState(false);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const advancingTeamsRef = useRef<Set<string>>(new Set());
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const reportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(HOST_GAME_CODE_KEY);
    if (stored) setGameCode(stored);
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const gamesRef = collection(db, "games");
    const q = isAdmin
      ? query(gamesRef, orderBy("createdAt", "desc"), limit(50))
      : query(gamesRef, where("ownerInstructorId", "==", userUid), orderBy("createdAt", "desc"));
    return onSnapshot(
      q,
      (snap) => {
        setSessions(
          snap.docs.map((d) => {
            const data = d.data() as Record<string, unknown>;
            return {
              id: d.id,
              status: toSessionStatus(data.status),
              createdAtMs: toMillis(data.createdAt) ?? 0,
              ownerInstructorEmail:
                typeof data.ownerInstructorEmail === "string"
                  ? data.ownerInstructorEmail
                  : undefined,
            };
          })
        );
      },
      (err) => {
        if (import.meta.env.DEV) console.error(err);
        setFeedback({ tone: "error", message: "Failed to load sessions." });
      }
    );
  }, [isAdmin, userUid]);

  useEffect(() => {
    if (!gameCode) {
      setGameStatus(null);
      setConfig(null);
      return;
    }
    return onSnapshot(doc(db, "games", gameCode), (snap) => {
      if (!snap.exists()) {
        setGameCode(null);
        localStorage.removeItem(HOST_GAME_CODE_KEY);
        return;
      }
      const data = snap.data() as Record<string, unknown>;
      setGameStatus(toSessionStatus(data.status));
      const nextCfg = isGameConfig(data.config) ? data.config : defaultConfig();
      setConfig(nextCfg);
      setConfigDraft(nextCfg);
      const nextNotes = typeof data.notes === "string" ? data.notes : "";
      setNotes(nextNotes);
      setSavedNotes(nextNotes);
    });
  }, [gameCode]);

  useEffect(() => {
    if (!gameCode || gameStatus !== "lobby") {
      setPlayers([]);
      return;
    }
    const q = query(collection(db, "games", gameCode, "players"), orderBy("createdAt", "asc"));
    return onSnapshot(q, (snap) => {
      setPlayers(
        snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : "",
            normalizedName: typeof data.normalizedName === "string" ? data.normalizedName : "",
            lastHeartbeatAtMs: toMillis(data.lastHeartbeatAt),
          };
        })
      );
    });
  }, [gameCode, gameStatus]);

  useEffect(() => {
    if (!gameCode || !config || gameStatus === "lobby" || !gameStatus) {
      setTeams([]);
      return;
    }
    return onSnapshot(collection(db, "games", gameCode, "teams"), (snap) => {
      setTeams(
        snap.docs.map((d) => ({
          ...(d.data() as TeamState),
          id: d.id,
        }))
      );
    });
  }, [gameCode, gameStatus, config]);

  useEffect(() => {
    if (!gameCode || !config || gameStatus !== "in_progress") return;
    const run = async () => {
      for (const team of teams) {
        if (team.currentWeek > config.nWeeks) continue;
        const waitFor = ROLES.filter((r) => !team.stages[r].isRobot);
        const allSubmitted = waitFor.length === 0 || waitFor.every((r) => team.ordersSubmitted?.[r]);
        if (!allSubmitted || advancingTeamsRef.current.has(team.id)) continue;
        try {
          advancingTeamsRef.current.add(team.id);
          const liveCfg = config;
          const orders = computeOrdersForWeek(team, liveCfg, team.pendingOrders || {});
          const { nextTeam } = simulateWeek(team, liveCfg, orders);
          nextTeam.pendingOrders = {};
          nextTeam.ordersSubmitted = {};
          await updateDoc(
            doc(db, "games", gameCode, "teams", team.id),
            nextTeam as unknown as Record<string, unknown>
          );
        } finally {
          advancingTeamsRef.current.delete(team.id);
        }
      }
    };
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      void run();
    }, 300);
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
    };
  }, [gameCode, config, gameStatus, teams]);

  const sanitizeConfig = (cfg: GameConfig): GameConfig => {
    const nWeeks = Math.max(1, Math.round(cfg.nWeeks));
    return {
      ...cfg,
      nWeeks,
      inventoryCost: Math.max(0, Number(cfg.inventoryCost) || 0),
      backlogCost: Math.max(0, Number(cfg.backlogCost) || 0),
      customerDemand: Array.isArray(cfg.customerDemand) && cfg.customerDemand.length === nWeeks
        ? cfg.customerDemand
        : Array.from({ length: nWeeks }, (_, i) => cfg.customerDemand?.[i] ?? (i < 4 ? 4 : 8)),
      extraOrderDelay: Boolean(cfg.extraOrderDelay),
      displayUpstreamBackorders: Boolean(cfg.displayUpstreamBackorders),
    };
  };

  const startNew = async () => {
    try {
      const created = await createSession({ notes: "", config: sanitizeConfig(defaultConfig()) });
      setGameCode(created.gameCode);
      localStorage.setItem(HOST_GAME_CODE_KEY, created.gameCode);
      setFeedback({ tone: "success", message: `Session ${created.gameCode} created.` });
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setFeedback({ tone: "error", message: "Failed to create session." });
    }
  };

  const selectSession = (code: string) => {
    setGameCode(code);
    localStorage.setItem(HOST_GAME_CODE_KEY, code);
    setFeedback({ tone: "success", message: `Managing session ${code}.` });
  };

  const removePlayer = async (p: LobbyPlayer) => {
    if (!gameCode) return;
    if (!window.confirm(`Remove ${p.name || "this player"} from session ${gameCode}?`)) {
      return;
    }
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "games", gameCode, "players", p.id));
      if (p.normalizedName) batch.delete(doc(db, "games", gameCode, "playerNames", p.normalizedName));
      await batch.commit();
      setFeedback({ tone: "success", message: "Player removed from lobby." });
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setFeedback({ tone: "error", message: "Unable to remove player." });
    }
  };

  const saveConfig = async () => {
    if (!gameCode) return;
    try {
      const clean = sanitizeConfig(configDraft);
      await updateDoc(doc(db, "games", gameCode), { config: clean, notes });
      setConfig(clean);
      setSavedNotes(notes);
      setFeedback({ tone: "success", message: "Session settings saved." });
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setFeedback({ tone: "error", message: "Unable to save session settings." });
    }
  };

  const startGame = async () => {
    if (!gameCode || !config || players.length === 0) return;
    try {
      await saveConfig();
      const gameRef = doc(db, "games", gameCode);
      const snap = await getDocs(collection(gameRef, "players"));
      const allPlayers = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          name: typeof data.name === "string" ? data.name : "Player",
        };
      });
      if (allPlayers.length === 0) return;

      const shuffled = [...allPlayers].sort(() => Math.random() - 0.5);
      const numTeams = Math.ceil(shuffled.length / 4);
      const baseHumans = Math.floor(shuffled.length / numTeams);
      const rem = shuffled.length % numTeams;
      const batch = writeBatch(db);
      const used = new Set<string>();
      let playerIdx = 0;

      for (let i = 0; i < numTeams; i += 1) {
        const teamId = `team${i + 1}`;
        const teamName = pickTeamName(i, used);
        const team = createInitialTeamState(teamId, teamName);
        const humans = baseHumans + (i < rem ? 1 : 0);
        const robots = Math.max(0, ROLES.length - humans);
        const teamPlayers = shuffled.slice(playerIdx, playerIdx + humans);
        playerIdx += humans;
        const robotRoles = ROLES.slice(0, robots);
        const humanRoles = ROLES.filter((r) => !robotRoles.includes(r));

        [...teamPlayers].sort(() => Math.random() - 0.5).forEach((player, idx) => {
          const role = humanRoles[idx];
          if (!role) return;
          team.stages[role].playerId = player.id;
          team.stages[role].playerName = player.name;
          team.stages[role].isRobot = false;
          team.humanCount += 1;
          batch.update(doc(db, "games", gameCode, "players", player.id), {
            teamId,
            teamName,
            role,
            isRobot: false,
          });
        });

        robotRoles.forEach((role) => {
          team.stages[role].playerId = null;
          team.stages[role].playerName = "Beer GPT";
          team.stages[role].isRobot = true;
        });

        batch.set(doc(db, "games", gameCode, "teams", teamId), team);
      }

      batch.update(gameRef, { status: "in_progress" });
      await batch.commit();
      setFeedback({ tone: "success", message: "Game started successfully." });
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setFeedback({ tone: "error", message: "Unable to start game." });
    }
  };

  const endSession = async () => {
    if (!gameCode) return;
    try {
      await updateDoc(doc(db, "games", gameCode), { status: "ended" });
      setFeedback({ tone: "success", message: `Session ${gameCode} marked as ended.` });
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setFeedback({ tone: "error", message: "Unable to end session." });
    }
  };

  const removeSession = async (code: string) => {
    if (
      !window.confirm(
        `Delete session ${code}? This permanently removes game state, teams, and player data.`
      )
    ) {
      return;
    }
    try {
      await deleteSession({ gameCode: code });
      if (code === gameCode) {
        setGameCode(null);
        localStorage.removeItem(HOST_GAME_CODE_KEY);
      }
      setFeedback({ tone: "success", message: `Session ${code} deleted.` });
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setFeedback({ tone: "error", message: `Unable to delete session ${code}.` });
    }
  };

  const kickToRobot = async (team: TeamState, role: Role) => {
    if (!gameCode) return;
    const stage = team.stages[role];
    if (!stage || stage.isRobot) return;

    const roleLabel = role[0].toUpperCase() + role.slice(1);
    if (
      !window.confirm(
        `Replace ${stage.playerName ?? "this player"} (${roleLabel}) with Beer GPT for session ${gameCode}?`
      )
    ) {
      return;
    }

    const opKey = `${team.id}:${role}`;
    setKickingRoleKey(opKey);
    try {
      await runTransaction(db, async (tx) => {
        const teamRef = doc(db, "games", gameCode, "teams", team.id);
        const teamSnap = await tx.get(teamRef);
        if (!teamSnap.exists()) return;
        const teamData = teamSnap.data() as Record<string, unknown>;
        const stages = (teamData.stages ?? {}) as Partial<Record<Role, Record<string, unknown>>>;
        const liveStage = stages[role];
        if (!liveStage || liveStage.isRobot === true) return;

        const playerId = typeof liveStage.playerId === "string" ? liveStage.playerId : null;
        const liveHumanCount = typeof teamData.humanCount === "number" ? teamData.humanCount : team.humanCount;

        tx.update(teamRef, {
          [`stages.${role}.playerId`]: null,
          [`stages.${role}.playerName`]: "Beer GPT",
          [`stages.${role}.isRobot`]: true,
          [`pendingOrders.${role}`]: deleteField(),
          [`ordersSubmitted.${role}`]: deleteField(),
          humanCount: Math.max(0, liveHumanCount - 1),
        });

        if (playerId) {
          const playerRef = doc(db, "games", gameCode, "players", playerId);
          tx.update(playerRef, {
            teamId: null,
            teamName: null,
            role: null,
            isRobot: false,
          });
        }
      });
      setFeedback({
        tone: "success",
        message: `${roleLabel} was switched to Beer GPT for team ${team.name}.`,
      });
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setFeedback({
        tone: "error",
        message: "Unable to kick player to robot. Please try again.",
      });
    } finally {
      setKickingRoleKey(null);
    }
  };

  const filteredSessions = useMemo(() => {
    const queryText = sessionSearch.trim().toLowerCase();
    return sessions.filter((session) => {
      const statusOk = sessionFilter === "all" || session.status === sessionFilter;
      if (!statusOk) {
        return false;
      }
      if (!queryText) {
        return true;
      }
      return [session.id, session.ownerInstructorEmail ?? ""].join(" ").toLowerCase().includes(queryText);
    });
  }, [sessionFilter, sessionSearch, sessions]);

  const presenceSummary = useMemo(() => {
    const onlineCount = players.filter(
      (player) => player.lastHeartbeatAtMs !== null && nowMs - player.lastHeartbeatAtMs <= ONLINE_THRESHOLD_MS
    ).length;
    return {
      onlineCount,
      offlineCount: Math.max(0, players.length - onlineCount),
    };
  }, [nowMs, players]);

  const configIsDirty = useMemo(() => {
    if (!config) {
      return false;
    }
    const cleanDraft = sanitizeConfig(configDraft);
    const cleanConfig = sanitizeConfig(config);
    return JSON.stringify(cleanDraft) !== JSON.stringify(cleanConfig) || notes !== savedNotes;
  }, [config, configDraft, notes, savedNotes]);

  const inProgressSummary = useMemo(() => {
    let waitingRoles = 0;
    let submittedRoles = 0;
    let waitingTeams = 0;

    for (const team of teams) {
      let teamWaiting = 0;
      for (const role of ROLES) {
        const stage = team.stages[role];
        if (stage.isRobot) continue;
        if (team.ordersSubmitted?.[role]) {
          submittedRoles += 1;
        } else {
          waitingRoles += 1;
          teamWaiting += 1;
        }
      }
      if (teamWaiting > 0) waitingTeams += 1;
    }

    return { waitingRoles, submittedRoles, waitingTeams };
  }, [teams]);

  const leaderboardRows = useMemo(() => buildLeaderboardRows(teams), [teams]);
  const stdDevRows = useMemo(() => buildStdDevRows(teams), [teams]);
  const orderedTeamsForReport = useMemo(() => {
    const byId = new Map(teams.map((team) => [team.id, team]));
    return leaderboardRows
      .map((row) => byId.get(row.teamId))
      .filter((team): team is TeamState => Boolean(team));
  }, [teams, leaderboardRows]);

  const downloadCompleteData = async () => {
    if (!gameCode) return;
    setCsvExporting(true);
    try {
      const gameRef = doc(db, "games", gameCode);
      const [gameSnap, teamsSnap, playersSnap] = await Promise.all([
        getDoc(gameRef),
        getDocs(collection(gameRef, "teams")),
        getDocs(collection(gameRef, "players")),
      ]);

      if (!gameSnap.exists()) {
        throw new Error("Session not found.");
      }

      const latestTeams: TeamState[] = teamsSnap.docs.map((teamDoc) => ({
        ...(teamDoc.data() as TeamState),
        id: teamDoc.id,
      }));
      const latestLeaderboardRows = buildLeaderboardRows(latestTeams);
      const latestStdDevRows = buildStdDevRows(latestTeams);

      downloadSessionCsvBundle({
        gameCode,
        sessionData: gameSnap.data() as Record<string, unknown>,
        teams: latestTeams,
        players: playersSnap.docs.map((playerDoc) => ({
          id: playerDoc.id,
          data: playerDoc.data() as Record<string, unknown>,
        })),
        leaderboardRows: latestLeaderboardRows,
        stdDevRows: latestStdDevRows,
      });

      setFeedback({ tone: "success", message: "Session data downloaded." });
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setFeedback({ tone: "error", message: "Unable to download session data." });
    } finally {
      setCsvExporting(false);
    }
  };

  const exportReportPdf = async () => {
    if (!gameCode || !reportRef.current) return;
    setPdfExporting(true);
    try {
      await exportElementToPdf({
        element: reportRef.current,
        fileName: `${gameCode}-endgame-report.pdf`,
      });
      setFeedback({ tone: "success", message: "PDF report exported." });
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      setFeedback({ tone: "error", message: "Unable to export PDF report." });
    } finally {
      setPdfExporting(false);
    }
  };

  return (
    <div className="dashboard-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>{isAdmin ? "Instructor Console (Admin)" : "Instructor Console"}</h2>
            <p>Launch and manage Beer Game sessions for your class roster.</p>
            <p className="text-muted">
              Sessions are automatically deleted 30 days after they are created. Download any data
              you need to keep before then.
            </p>
          </div>
          <span className="chip chip-neutral">{instructorEmail}</span>
        </div>

        <div className="toolbar">
          <div className="toolbar-field">
            <label htmlFor="session-search">Search sessions</label>
            <input
              id="session-search"
              className="input"
              type="text"
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
              placeholder="Session code or owner email"
            />
          </div>
          <div className="toolbar-field">
            <label htmlFor="session-filter">Status filter</label>
            <select
              id="session-filter"
              className="select"
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value as SessionStatusFilter)}
            >
              <option value="all">All sessions</option>
              <option value="lobby">Lobby</option>
              <option value="in_progress">In progress</option>
              <option value="ended">Ended</option>
            </select>
          </div>
          <div className="toolbar-field">
            <button className="btn-primary" onClick={startNew}>
              Create new session
            </button>
          </div>
        </div>

        {filteredSessions.length === 0 ? (
          <div className="empty-state" style={{ marginTop: "0.9rem" }}>
            No sessions match your current filters.
          </div>
        ) : (
          <div className="card-grid" style={{ marginTop: "0.9rem" }}>
            {filteredSessions.map((s) => (
              <article key={s.id} className="item-card">
                <h4>{s.id}</h4>
                <p className="item-card-meta">
                  Status: <span className={`chip chip-${s.status}`}>{s.status.replace("_", " ")}</span>
                </p>
                <p className="item-card-meta">
                  Created {new Date(s.createdAtMs || Date.now()).toLocaleString()}
                </p>
                {isAdmin && s.ownerInstructorEmail && (
                  <p className="item-card-meta">Owner: {s.ownerInstructorEmail}</p>
                )}
                <div className="actions-row">
                  <button
                    className={gameCode === s.id ? "btn-subtle" : "btn-primary"}
                    disabled={gameCode === s.id}
                    onClick={() => selectSession(s.id)}
                  >
                    {gameCode === s.id ? "Managing" : "Manage"}
                  </button>
                  <button className="btn-danger" onClick={() => removeSession(s.id)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {gameCode && config && (
        <section className="panel panel-muted">
          <div className="section-header">
            <div>
              <h3>Active Session</h3>
              <p>
                Session <strong>{gameCode}</strong> is currently{" "}
                <span className={`chip chip-${gameStatus ?? "neutral"}`}>{gameStatus ?? "unknown"}</span>
              </p>
            </div>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="cfg-weeks">Total weeks</label>
              <input
                id="cfg-weeks"
                className="input"
                type="number"
                min={1}
                value={configDraft.nWeeks}
                onChange={(e) =>
                  setConfigDraft((p) => ({ ...p, nWeeks: parseInt(e.target.value, 10) || 1 }))
                }
              />
              <p className="field-help">Number of simulated weeks in this session.</p>
            </div>
            <div className="field">
              <label htmlFor="cfg-inventory-cost">Inventory cost</label>
              <input
                id="cfg-inventory-cost"
                className="input"
                type="number"
                min={0}
                step="0.1"
                value={configDraft.inventoryCost}
                onChange={(e) =>
                  setConfigDraft((p) => ({ ...p, inventoryCost: parseFloat(e.target.value) || 0 }))
                }
              />
              <p className="field-help">Weekly cost per unit of inventory held.</p>
            </div>
            <div className="field">
              <label htmlFor="cfg-backlog-cost">Backlog cost</label>
              <input
                id="cfg-backlog-cost"
                className="input"
                type="number"
                min={0}
                step="0.1"
                value={configDraft.backlogCost}
                onChange={(e) =>
                  setConfigDraft((p) => ({ ...p, backlogCost: parseFloat(e.target.value) || 0 }))
                }
              />
              <p className="field-help">Weekly penalty per unit of unmet demand.</p>
            </div>
          </div>

          <div className="checkbox-row">
            <label className="checkbox-control" htmlFor="cfg-extra-order-delay">
              <input
                id="cfg-extra-order-delay"
                type="checkbox"
                checked={Boolean(configDraft.extraOrderDelay)}
                onChange={(e) =>
                  setConfigDraft((p) => ({ ...p, extraOrderDelay: e.target.checked }))
                }
              />
              Use extra order delay
            </label>
            <label className="checkbox-control" htmlFor="cfg-show-upstream-backorders">
              <input
                id="cfg-show-upstream-backorders"
                type="checkbox"
                checked={Boolean(configDraft.displayUpstreamBackorders)}
                onChange={(e) =>
                  setConfigDraft((p) => ({
                    ...p,
                    displayUpstreamBackorders: e.target.checked,
                  }))
                }
              />
              Show upstream backorders
            </label>
          </div>

          <div className="field" style={{ marginTop: "0.9rem" }}>
            <label htmlFor="cfg-notes">Session notes</label>
            <textarea
              id="cfg-notes"
              className="textarea"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <p className="field-help">
              Shared context for students or facilitators. Saved with session settings.
            </p>
          </div>

          <div className="actions-row">
            <button className="btn-primary" onClick={saveConfig} disabled={!configIsDirty}>
              Save settings
            </button>
            {gameStatus === "lobby" && (
              <button className="btn-subtle" onClick={startGame} disabled={players.length === 0}>
                Start game
              </button>
            )}
            {gameStatus !== "ended" && (
              <button className="btn-danger" onClick={endSession}>
                End session
              </button>
            )}
          </div>
          {!configIsDirty && (
            <p className="field-help" style={{ marginTop: "0.6rem" }}>
              No unsaved changes.
            </p>
          )}
        </section>
      )}

      {gameCode && gameStatus === "lobby" && (
        <section className="panel">
          <div className="section-header">
            <div>
              <h3>Lobby Presence</h3>
              <p>Track who is online before you start the game.</p>
            </div>
            <div className="tab-row">
              <span className="chip chip-online">{presenceSummary.onlineCount} online</span>
              <span className="chip chip-offline">{presenceSummary.offlineCount} offline</span>
            </div>
          </div>

          {players.length === 0 ? (
            <div className="empty-state">No players have joined this lobby yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Last seen</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p) => {
                    const online =
                      p.lastHeartbeatAtMs !== null &&
                      nowMs - p.lastHeartbeatAtMs <= ONLINE_THRESHOLD_MS;
                    const seen =
                      p.lastHeartbeatAtMs === null
                        ? "No heartbeat yet"
                        : `${Math.max(0, Math.floor((nowMs - p.lastHeartbeatAtMs) / 1000))}s ago`;
                    return (
                      <tr key={p.id} className={online ? "" : "row-offline"}>
                        <td>{p.name}</td>
                        <td>
                          <span className={`chip ${online ? "chip-online" : "chip-offline"}`}>
                            {online ? "online" : "offline"}
                          </span>
                        </td>
                        <td>{seen}</td>
                        <td>
                          <button className="btn-danger" onClick={() => removePlayer(p)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {gameCode && gameStatus === "in_progress" && (
        <section className="panel">
          <div className="section-header">
            <div>
              <h3>In-Progress Teams</h3>
              <p>Track role-level progress and unblock stuck decisions in real time.</p>
            </div>
            <div className="tab-row">
              <span className="chip chip-success">{inProgressSummary.submittedRoles} submitted</span>
              <span className="chip chip-pending">{inProgressSummary.waitingRoles} waiting</span>
              <span className="chip chip-neutral">{inProgressSummary.waitingTeams} teams waiting</span>
            </div>
          </div>

          {teams.length === 0 ? (
            <div className="empty-state">Waiting for teams to initialize...</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table teams-compact-table">
                <colgroup>
                  <col className="teams-col-team" />
                  <col className="teams-col-week" />
                  <col className="teams-col-cost" />
                  <col className="teams-col-role" />
                  <col className="teams-col-role" />
                  <col className="teams-col-role" />
                  <col className="teams-col-role" />
                  <col className="teams-col-waiting" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Team</th>
                    <th className="num teams-col-center">Week</th>
                    <th className="num teams-col-center">Cost</th>
                    <th>Retailer</th>
                    <th>Wholesaler</th>
                    <th>Distributor</th>
                    <th>Factory</th>
                    <th className="num">Waiting</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((team) => {
                    const waitingCount = ROLES.filter(
                      (role) => !team.stages[role].isRobot && !team.ordersSubmitted?.[role]
                    ).length;
                    return (
                      <tr key={team.id} className={waitingCount > 0 ? "row-waiting" : ""}>
                        <td>
                          <strong>{team.name}</strong>
                        </td>
                        <td className="num teams-col-center">
                          {team.currentWeek}
                          {config ? `/${config.nWeeks}` : ""}
                        </td>
                        <td className="num teams-col-center">${(team.totalCost || 0).toFixed(2)}</td>
                        {ROLES.map((role) => {
                          const stage = team.stages[role];
                          const isHuman = !stage.isRobot;
                          const hasSubmitted = Boolean(team.ordersSubmitted?.[role]);
                          const opKey = `${team.id}:${role}`;
                          return (
                            <td key={role}>
                                <div className="team-role-cell">
                                  <div className="team-role-main">{stage.playerName ?? "Beer GPT"}</div>
                                  <div className="team-role-sub">
                                    <RoleTypeIcon isHuman={isHuman} />
                                    {isHuman ? (
                                      <RoleDecisionIcon isSubmitted={hasSubmitted} />
                                    ) : (
                                      <span className="team-role-status-placeholder" aria-hidden="true" />
                                    )}
                                    {isHuman ? (
                                      <button
                                        className="btn-link btn-kick-icon"
                                        aria-label="Kick player and replace with robot"
                                        title="Kick player and replace with robot"
                                        disabled={kickingRoleKey === opKey}
                                        onClick={() => kickToRobot(team, role)}
                                      >
                                        {kickingRoleKey === opKey ? "…" : "↺"}
                                      </button>
                                    ) : (
                                      <span className="team-role-action-placeholder" aria-hidden="true" />
                                    )}
                                </div>
                              </div>
                            </td>
                          );
                        })}
                        <td className="num">
                          <strong>{waitingCount}</strong>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {gameCode && gameStatus === "ended" && (
        <section className="panel endgame-panel">
          <div className="section-header">
            <div>
              <h3>Endgame Statistics</h3>
              <p>Session results, bullwhip metrics, and order variability by team.</p>
            </div>
            <span className="chip chip-ended">Session ended</span>
          </div>

          <div className="actions-row export-actions">
            <button className="btn-subtle" onClick={downloadCompleteData} disabled={csvExporting}>
              {csvExporting ? "Preparing CSV bundle..." : "Download complete data"}
            </button>
            <button className="btn-primary" onClick={exportReportPdf} disabled={pdfExporting}>
              {pdfExporting ? "Building PDF..." : "Export leaderboard + charts (PDF)"}
            </button>
          </div>

          <div className="endgame-report" ref={reportRef}>
            <section className="endgame-block">
              <div className="section-header">
                <div>
                  <h4>Leaderboard</h4>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="num">Rank</th>
                      <th>Team</th>
                      <th className="num">Total cost</th>
                      <th className="num"># Robo players</th>
                      <th className="num">Bullwhip</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboardRows.map((row) => (
                      <tr key={row.teamId}>
                        <td className="num">{row.rank}</td>
                        <td>{row.teamName}</td>
                        <td className="num">${row.totalCost.toFixed(2)}</td>
                        <td className="num">{row.robotCount}</td>
                        <td className="num">{formatBullwhip(row.bullwhip)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="endgame-block">
              <div className="section-header">
                <div>
                  <h4>Orders Over Time (All Teams)</h4>
                </div>
              </div>
              <div className="endgame-chart-grid">
                {orderedTeamsForReport.map((team) => (
                  <article key={team.id} className="endgame-chart-card">
                    <h5>{team.name}</h5>
                    <TeamOrdersLineChart team={team} />
                  </article>
                ))}
              </div>
            </section>

            <section className="endgame-block">
              <div className="section-header">
                <div>
                  <h4>Order Standard Deviation by Team and Role</h4>
                </div>
              </div>
              <TeamRoleStdDevGroupedBarChart rows={stdDevRows} />
            </section>
          </div>
        </section>
      )}

      <div aria-live="polite">
        {feedback && (
          <div className={`alert ${feedback.tone === "error" ? "alert-error" : "alert-success"}`}>
            {feedback.message}
          </div>
        )}
      </div>
    </div>
  );
};

function RoleTypeIcon({ isHuman }: { isHuman: boolean }) {
  return (
    <span
      className="team-role-icon"
      aria-label={isHuman ? "Human" : "Robot"}
      title={isHuman ? "Human" : "Robot"}
    >
      <span className="team-role-icon-emoji" aria-hidden="true">
        {isHuman ? "👤" : "🤖"}
      </span>
    </span>
  );
}

function RoleDecisionIcon({ isSubmitted }: { isSubmitted: boolean }) {
  return (
    <span
      className={`team-role-status-icon ${isSubmitted ? "is-submitted" : "is-waiting"}`}
      aria-label={isSubmitted ? "Submitted" : "Waiting"}
      title={isSubmitted ? "Submitted" : "Waiting"}
    >
      <span aria-hidden="true">{isSubmitted ? "✓" : "⌛"}</span>
    </span>
  );
}

function pickTeamName(index: number, used: Set<string>): string {
  const available = BEER_TEAM_NAMES.filter((name) => !used.has(name));
  let chosen: string;
  if (available.length > 0) chosen = available[Math.floor(Math.random() * available.length)];
  else {
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

function toSessionStatus(value: unknown): SessionLite["status"] {
  if (value === "lobby" || value === "in_progress" || value === "ended") {
    return value;
  }
  return "lobby";
}

function toMillis(value: unknown): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const timestamp = value as { toMillis?: () => number; seconds?: number };
  if (typeof timestamp.toMillis === "function") {
    return timestamp.toMillis();
  }
  if (typeof timestamp.seconds === "number") {
    return timestamp.seconds * 1000;
  }
  return null;
}

function isGameConfig(value: unknown): value is GameConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const cfg = value as Partial<GameConfig>;
  return (
    typeof cfg.nWeeks === "number" &&
    typeof cfg.inventoryCost === "number" &&
    typeof cfg.backlogCost === "number" &&
    Array.isArray(cfg.customerDemand) &&
    typeof cfg.extraOrderDelay === "boolean"
  );
}

function formatBullwhip(value: number | null): string {
  if (value === null) return "N/A";
  return value.toFixed(3);
}

export default HostLobby;
