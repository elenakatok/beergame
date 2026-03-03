// src/components/PlayerView.tsx
import React, { useEffect, useState, useRef } from "react";
import { db } from "../firebase";
import { doc, onSnapshot } from "firebase/firestore";
import { GameConfig, Role, TeamState, ROLES } from "../logic/gameModel";
import { heartbeatPlayer, submitPlayerOrder } from "../api";
import waitingBg from "../waitingscreen.webp";
import TeamOrdersLineChart from "./charts/TeamOrdersLineChart";

const PLAYER_GAME_CODE_KEY = "beerGame_player_gameCode";
const PLAYER_ID_KEY = "beerGame_player_playerId";
const PLAYER_ROLE_KEY = "beerGame_player_role";
const PLAYER_TOKEN_KEY = "beerGame_player_sessionToken";
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_FAILURE_DISCONNECT_COUNT = 3;
const MAX_ORDER_AMOUNT = 50;
const OVERSTOCK_THRESHOLD = 40;

interface PlayerData {
  id: string;
  name: string;
  teamId: string | null;
  role: Role | null;
  isRobot: boolean;
  teamName?: string | null;
}

type GameSessionStatus = "lobby" | "in_progress" | "ended";
type Phase = 0 | 1 | 2 | 3 | 4; // 1: receiving, 2: reveal demand, 3: shipping, 4: costs

const PlayerView: React.FC = () => {
  const [storedSession] = useState(getStoredPlayerSession);
  const hasStoredSession =
    Boolean(storedSession.gameCode) && Boolean(storedSession.playerId) && Boolean(storedSession.sessionToken);

  const gameCode = storedSession.gameCode;
  const playerId = storedSession.playerId;
  const [gameStatus, setGameStatus] = useState<GameSessionStatus | null>(null);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [player, setPlayer] = useState<PlayerData | null>(null);
  const [team, setTeam] = useState<TeamState | null>(null);
  const [error, setError] = useState<string | null>(
    hasStoredSession ? null : "No active player session found. Please rejoin from the home screen."
  );
  const sessionToken = storedSession.sessionToken;
  const [heartbeatFailureCount, setHeartbeatFailureCount] = useState(0);
  const [browserOnline, setBrowserOnline] = useState<boolean>(navigator.onLine);
  const [orderSubmitFailed, setOrderSubmitFailed] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const isDisconnected =
    !browserOnline || heartbeatFailureCount >= HEARTBEAT_FAILURE_DISCONNECT_COUNT || orderSubmitFailed;

  // Game subscription
  useEffect(() => {
    if (!gameCode) return;
    const gameRef = doc(db, "games", gameCode);
    const unsub = onSnapshot(gameRef, (snap) => {
      if (!snap.exists()) {
        setError("Game not found. It may have been deleted.");
        return;
      }
      const data = snap.data() as Record<string, unknown>;
      setGameStatus(toGameStatus(data.status));
      setConfig(isGameConfig(data.config) ? data.config : null);
    });
    return unsub;
  }, [gameCode]);

  // Player subscription
  useEffect(() => {
    if (!gameCode || !playerId) return;
    const playerRef = doc(db, "games", gameCode, "players", playerId);
    const unsub = onSnapshot(playerRef, (snap) => {
      if (!snap.exists()) {
        setError("You were removed from this game by the host.");
        return;
      }
      const d = snap.data() as Record<string, unknown>;
      const p: PlayerData = {
        id: snap.id,
        name: typeof d.name === "string" ? d.name : "Player",
        teamId: typeof d.teamId === "string" ? d.teamId : null,
        role: toRole(d.role),
        isRobot: d.isRobot === true,
        teamName: typeof d.teamName === "string" ? d.teamName : null,
      };
      setPlayer(p);
      if (p.role) {
        sessionStorage.setItem(PLAYER_ROLE_KEY, p.role);
      }
    });
    return unsub;
  }, [gameCode, playerId]);

  // Team subscription
  useEffect(() => {
    if (!gameCode || !player?.teamId) return;
    const teamRef = doc(db, "games", gameCode, "teams", player.teamId);
    const unsub = onSnapshot(teamRef, (snap) => {
      if (!snap.exists()) {
        setTeam(null);
        return;
      }
      const data = snap.data() as Record<string, unknown>;
      setTeam({
        ...(data as unknown as TeamState),
        id: typeof data.id === "string" ? data.id : snap.id,
      });
    });
    return unsub;
  }, [gameCode, player?.teamId]);

  useEffect(() => {
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (!gameCode || !playerId || !sessionToken) return;
    if (gameStatus && gameStatus !== "lobby") return;

    let cancelled = false;
    const ping = async () => {
      try {
        await heartbeatPlayer({ gameCode, playerId, sessionToken });
        if (!cancelled) {
          setHeartbeatFailureCount(0);
        }
      } catch (err) {
        if (import.meta.env.DEV) console.error("heartbeat failed", err);
        if (!cancelled) {
          setHeartbeatFailureCount((prev) => prev + 1);
        }
      }
    };

    void ping();
    const id = window.setInterval(ping, HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [gameCode, playerId, sessionToken, gameStatus]);

  const handleSubmitOrder = async (order: number) => {
    if (!gameCode || !playerId || !sessionToken || !player?.teamId || !player.role) return;
    if (!team) return;
    if (isDisconnected) return;
    if (team.ordersSubmitted && team.ordersSubmitted[player.role]) {
      return; // already submitted
    }

    try {
      await submitPlayerOrder({
        gameCode,
        playerId,
        sessionToken,
        order,
      });
      setHeartbeatFailureCount(0);
      setOrderSubmitFailed(false);
      setOrderError(null);
    } catch {
      setOrderSubmitFailed(true);
      setOrderError("Order failed to submit. Check your connection and try again.");
    }
  };

  if (error) {
    return <div style={{ color: "red" }}>{error}</div>;
  }

  if (!player || !gameCode || !gameStatus || !config) {
    return <div>Loading player session…</div>;
  }

  const hasCompletedAllWeeks =
    !!team && team.currentWeek > (config?.nWeeks ?? Number.MAX_SAFE_INTEGER);
  const isGameOverForPlayer = gameStatus === "ended" || hasCompletedAllWeeks;

  if (gameStatus === "lobby") {
    return (
      <div
        style={{
          minHeight: "100vh",
          backgroundImage: `linear-gradient(rgba(255,255,255,0.9), rgba(255,255,255,0.9)), url(${waitingBg})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          padding: "1.25rem",
        }}
      >
        <h2>Lobby</h2>
        <p>
          Hi <strong>{player.name}</strong>, you have joined game{" "}
          <code>{gameCode}</code>.
        </p>
        <p>The host is still setting up teams. Please wait until the game starts.</p>
      </div>
    );
  }

  if (gameStatus === "in_progress" && (!player.teamId || !player.role)) {
    return (
      <div
        style={{
          minHeight: "100vh",
          backgroundImage: `linear-gradient(rgba(255,255,255,0.9), rgba(255,255,255,0.9)), url(${waitingBg})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          padding: "1.25rem",
        }}
      >
        <h2>Assigning teams…</h2>
        <p>
          The host has started the game. You will be placed into a team and role
          in a moment.
        </p>
      </div>
    );
  }

  if (isGameOverForPlayer) {
    return (
      <div style={{ padding: "1rem" }}>
        <h2>Game over</h2>
        <p>
          Thank you for playing, <strong>{player.name}</strong>.
        </p>
        {player.teamName && (
          <p>
            Your team was <strong>{player.teamName}</strong>.
          </p>
        )}
        {team && (
          <>
            <p>
              Your supply chain&apos;s total cost was{" "}
              <strong>${team.totalCost.toFixed(2)}</strong>.
            </p>
            <div
              style={{
                marginTop: "1rem",
                padding: "0.75rem 1rem",
                borderRadius: "0.75rem",
                border: "1px solid #ddd",
                background: "#faf6e9",
                maxWidth: 420,
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>
                Orders over time (your team)
              </h3>
              <p
                style={{
                  fontSize: "0.8rem",
                  color: "#555",
                  marginTop: 0,
                  marginBottom: "0.5rem",
                }}
              >
                Each line shows the orders placed by one supply chain stage in
                each week.
              </p>
              <TeamOrdersLineChart team={team} />
            </div>
          </>
        )}
        <p style={{ marginTop: "1rem" }}>You can now return to the home screen.</p>
      </div>
    );
  }

  if (!team || !player.role) {
    return <div>Loading team state…</div>;
  }

  const myRole = player.role;
  const myOrderSubmitted =
    !!team.ordersSubmitted && !!team.ordersSubmitted[myRole];

  return (
    <PlayerBoard
      team={team}
      role={myRole}
      playerName={player.name}
      config={config}
      onSubmitOrder={handleSubmitOrder}
      orderAlreadySubmitted={myOrderSubmitted}
      connectionHealthy={!isDisconnected}
      showDisconnectOverlay={isDisconnected}
      orderError={orderError}
    />
  );
};

interface PlayerBoardProps {
  team: TeamState;
  role: Role;
  playerName: string;
  config: GameConfig;
  onSubmitOrder: (order: number) => void;
  orderAlreadySubmitted: boolean;
  connectionHealthy: boolean;
  showDisconnectOverlay: boolean;
  orderError?: string | null;
}

const PlayerBoard: React.FC<PlayerBoardProps> = ({
  team,
  role,
  playerName,
  config,
  onSubmitOrder,
  orderAlreadySubmitted,
  connectionHealthy,
  showDisconnectOverlay,
  orderError,
}) => {
  const me = team.stages[role];
  const week = team.currentWeek;
  const isFactory = role === "factory";

  const lastRecord =
    me.history.length > 0 ? me.history[me.history.length - 1] : null;

  // Downstream partner (whose pipeline you see on the left)
  const partnerDownstream =
    role === "factory"
      ? team.stages["distributor"]
      : role === "distributor"
      ? team.stages["wholesaler"]
      : role === "wholesaler"
      ? team.stages["retailer"]
      : null;
  const partnerUpstream =
    role === "retailer"
      ? team.stages["wholesaler"]
      : role === "wholesaler"
      ? team.stages["distributor"]
      : role === "distributor"
      ? team.stages["factory"]
      : null;

  const [phase, setPhase] = useState<Phase>(0);
  const [canOrder, setCanOrder] = useState(false);

  // Incoming order card visibility
  const [showIncomingOrder, setShowIncomingOrder] = useState(false);

  // Blinking banner
  const [blinkOn, setBlinkOn] = useState(true);
  const [meterBlinkOn, setMeterBlinkOn] = useState(true);

  const robotCount = ROLES.filter((r) => team.stages[r].isRobot).length;
  const submittedHumans = ROLES.filter(
    (r) => !team.stages[r].isRobot && !!team.ordersSubmitted?.[r]
  ).length;
  const progressNumerator = robotCount + submittedHumans;
  const progressDenominator = ROLES.length;
  const humanRoles = ROLES.filter((r) => !team.stages[r].isRobot);
  const undecidedHumans = humanRoles.filter((r) => !team.ordersSubmitted?.[r]);
  const isLastUndecidedHuman =
    humanRoles.length > 1 &&
    undecidedHumans.length === 1 &&
    undecidedHumans[0] === role &&
    !orderAlreadySubmitted;

  // Truck animation
  const [truckPhase, setTruckPhase] = useState<"receiving" | "shipping" | null>(
    null
  );
  const [truckProgress, setTruckProgress] = useState(0); // 0 -> 1

  // Displayed (animated) values
  const [displayInventory, setDisplayInventory] = useState<number>(
    me.inventory
  );
  const [displayBacklog, setDisplayBacklog] = useState<number>(me.backlog);
  const [displayInvCost, setDisplayInvCost] = useState<number>(0);
  const [displayBacklogCost, setDisplayBacklogCost] = useState<number>(0);

  const [displayInDelay1, setDisplayInDelay1] = useState<number>(me.delay1);
  const [displayInDelay2, setDisplayInDelay2] = useState<number>(me.delay2);
  const [displayDownDelay1, setDisplayDownDelay1] = useState<number>(
    partnerDownstream ? partnerDownstream.delay1 : 0
  );
  const [displayDownDelay2, setDisplayDownDelay2] = useState<number>(
    partnerDownstream ? partnerDownstream.delay2 : 0
  );

  // Order input — clear each week (no previous order bias)
  const [orderInput, setOrderInput] = useState<string>("");
  const [showClampedNotice, setShowClampedNotice] = useState(false);
  const [pendingHighOrder, setPendingHighOrder] = useState<number | null>(null);

  // Store previous week's values so we can animate from them
  const prevRef = useRef({
    inventory: me.inventory,
    backlog: me.backlog,
    inDelay1: me.delay1,
    inDelay2: me.delay2,
    downDelay1: partnerDownstream ? partnerDownstream.delay1 : 0,
    downDelay2: partnerDownstream ? partnerDownstream.delay2 : 0,
  });

  // Animations are disabled in the very first round (week 1)
  const animationsEnabled = week > 1;

  // Helper: animate integers in visible steps
  const animateInt = (
    from: number,
    to: number,
    stepMs: number,
    setter: (val: number) => void,
    handles: number[]
  ) => {
    if (from === to) {
      setter(to);
      return;
    }
    let current = from;
    setter(current);
    const dir = from < to ? 1 : -1;
    const id = window.setInterval(() => {
      current += dir;
      if ((dir > 0 && current >= to) || (dir < 0 && current <= to)) {
        current = to;
        setter(current);
        window.clearInterval(id);
      } else {
        setter(current);
      }
    }, stepMs);
    handles.push(id);
  };

  // Helper: smooth animation for costs
  const animateNumber = (
    from: number,
    to: number,
    durationMs: number,
    setter: (val: number) => void
  ) => {
    if (durationMs <= 0 || from === to) {
      setter(to);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const val = from + (to - from) * t;
      setter(val);
      if (t < 1) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  };

  // Blinking banner effect
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!animationsEnabled) {
      setBlinkOn(true);
      return;
    }

    if (phase === 1 || phase === 2 || phase === 3) {
      setBlinkOn(true);
      const id = window.setInterval(() => {
        setBlinkOn((prev) => !prev);
      }, 500);
      return () => window.clearInterval(id);
    } else {
      setBlinkOn(true);
    }
  }, [phase, animationsEnabled]);

  useEffect(() => {
    if (!isLastUndecidedHuman) {
      setMeterBlinkOn(true);
      return;
    }
    const id = window.setInterval(() => {
      setMeterBlinkOn((prev) => !prev);
    }, 450);
    return () => window.clearInterval(id);
  }, [isLastUndecidedHuman]);

  // Truck animation (2 seconds) for receiving (phase 1) and shipping (phase 3, non-retailer)
  useEffect(() => {
    if (!animationsEnabled) {
      setTruckPhase(null);
      setTruckProgress(0);
      return;
    }

    let animId: number | undefined;
    if (phase === 1) {
      setTruckPhase("receiving");
      setTruckProgress(0);
      const start = performance.now();
      const duration = 2000;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        setTruckProgress(t);
        if (t < 1) {
          animId = requestAnimationFrame(step);
        }
      };
      animId = requestAnimationFrame(step);
    } else if (phase === 3 && role !== "retailer") {
      setTruckPhase("shipping");
      setTruckProgress(0);
      const start = performance.now();
      const duration = 2000;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        setTruckProgress(t);
        if (t < 1) {
          animId = requestAnimationFrame(step);
        }
      };
      animId = requestAnimationFrame(step);
    } else {
      setTruckPhase(null);
      setTruckProgress(0);
    }

    return () => {
      if (animId !== undefined) {
        cancelAnimationFrame(animId);
      }
    };
  }, [phase, role, animationsEnabled]);

  // Animation sequence: 1) supplies arrive, 2) reveal demand,
  // 3) shipments and downstream pipeline, 4) costs + enable order.
  useEffect(() => {
    const prev = prevRef.current;
    const target = {
      inventory: me.inventory,
      backlog: me.backlog,
      inDelay1: me.delay1,
      inDelay2: me.delay2,
      downDelay1: partnerDownstream
        ? partnerDownstream.delay1
        : prev.downDelay1,
      downDelay2: partnerDownstream
        ? partnerDownstream.delay2
        : prev.downDelay2,
    };

    // First round: no animations, show everything immediately
    if (!animationsEnabled) {
      setDisplayInventory(target.inventory);
      setDisplayBacklog(target.backlog);
      setDisplayInDelay1(target.inDelay1);
      setDisplayInDelay2(target.inDelay2);
      setDisplayDownDelay1(target.downDelay1);
      setDisplayDownDelay2(target.downDelay2);

      const targetInvCost = target.inventory * 0.5;
      const targetBacklogCost = target.backlog * 1.0;
      setDisplayInvCost(targetInvCost);
      setDisplayBacklogCost(targetBacklogCost);

      setPhase(0);
      setCanOrder(true);
      setOrderInput("");
      setShowIncomingOrder(true);
      setTruckPhase(null);
      setTruckProgress(0);

      // Initialize previous for the next (animated) week
      prevRef.current = {
        inventory: target.inventory,
        backlog: target.backlog,
        inDelay1: target.inDelay1,
        inDelay2: target.inDelay2,
        downDelay1: target.downDelay1,
        downDelay2: target.downDelay2,
      };

      return;
    }

    // "Supplies arrive": inventory increases by prev.inDelay1,
    // pipeline shifts: Delay1 <- Delay2, Delay2 -> 0.
    const arrivalInventory = prev.inventory + prev.inDelay1;
    const arrivalInDelay1 = prev.inDelay2;
    const arrivalInDelay2 = 0;

    // Initial visual state: previous week's end state, costs zero, orders hidden
    setDisplayInventory(prev.inventory);
    setDisplayBacklog(prev.backlog);
    setDisplayInDelay1(prev.inDelay1);
    setDisplayInDelay2(prev.inDelay2);
    setDisplayDownDelay1(prev.downDelay1);
    setDisplayDownDelay2(prev.downDelay2);
    setDisplayInvCost(0);
    setDisplayBacklogCost(0);
    setPhase(0);
    setCanOrder(false);
    setOrderInput("");
    setShowIncomingOrder(false);
    setTruckPhase(null);
    setTruckProgress(0);

    const phaseDuration = 1200; // ~1.2 seconds per main step
    const handles: number[] = [];

    const schedulePhase = (p: Phase, index: number) => {
      const t = window.setTimeout(() => {
        setPhase(p);

        if (p === 1) {
          // 1) Supplies arrive: pipeline -> inventory
          animateInt(
            prev.inDelay1,
            arrivalInDelay1,
            120,
            setDisplayInDelay1,
            handles
          );
          animateInt(
            prev.inDelay2,
            arrivalInDelay2,
            120,
            setDisplayInDelay2,
            handles
          );
          animateInt(
            prev.inventory,
            arrivalInventory,
            120,
            setDisplayInventory,
            handles
          );
        }

        if (p === 2) {
          // 2) Reveal demand / incoming orders
          setShowIncomingOrder(true);
        }

        if (p === 3) {
          // 3) Shipments and downstream pipeline
          // Inventory drops from arrival inventory to final inventory
          animateInt(
            arrivalInventory,
            target.inventory,
            120,
            setDisplayInventory,
            handles
          );
          // Backlog updates from previous backlog to final backlog
          animateInt(
            prev.backlog,
            target.backlog,
            120,
            setDisplayBacklog,
            handles
          );
          // Downstream shipping pipeline (your shipments to partner)
          animateInt(
            prev.downDelay1,
            target.downDelay1,
            120,
            setDisplayDownDelay1,
            handles
          );
          animateInt(
            prev.downDelay2,
            target.downDelay2,
            120,
            setDisplayDownDelay2,
            handles
          );
          // Incoming pipeline for you (new shipments entering delay2 then 1)
          animateInt(
            arrivalInDelay1,
            target.inDelay1,
            120,
            setDisplayInDelay1,
            handles
          );
          animateInt(
            arrivalInDelay2,
            target.inDelay2,
            120,
            setDisplayInDelay2,
            handles
          );
        }

        if (p === 4) {
          // 4) Costs reveal + enable ordering
          const targetInvCost = target.inventory * 0.5;
          const targetBacklogCost = target.backlog * 1.0;
          animateNumber(0, targetInvCost, 500, setDisplayInvCost);
          animateNumber(0, targetBacklogCost, 500, setDisplayBacklogCost);
          setCanOrder(true);
        }
      }, phaseDuration * index);
      handles.push(t);
    };

    const sequence: Phase[] = [1, 2, 3, 4];
    sequence.forEach((p, idx) => schedulePhase(p, idx));

    // Update previous values for next week
    prevRef.current = {
      inventory: target.inventory,
      backlog: target.backlog,
      inDelay1: target.inDelay1,
      inDelay2: target.inDelay2,
      downDelay1: target.downDelay1,
      downDelay2: target.downDelay2,
    };

    return () => {
      handles.forEach((id) => {
        window.clearTimeout(id);
        window.clearInterval(id);
      });
    };
    // Only depend on week so that partner decisions within the same week
    // don't retrigger your animations, but also on animationsEnabled so we
    // switch from static week 1 to animated week 2 correctly.
  }, [week, animationsEnabled]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleSubmit = () => {
    if (orderAlreadySubmitted || !canOrder || !connectionHealthy) return;

    const raw = Number(orderInput);
    if (Number.isNaN(raw)) {
      return;
    }

    const normalized = Math.round(raw);

    if (normalized < 0) {
      const clamped = 0;
      setOrderInput(clamped.toString());
      setShowClampedNotice(true);
      onSubmitOrder(clamped);
      return;
    }

    if (normalized > MAX_ORDER_AMOUNT) {
      setPendingHighOrder(normalized);
      return;
    }

    setOrderInput(normalized.toString());
    onSubmitOrder(normalized);
  };

  const supplyChainCostSoFar = team.totalCost;
  const myCumulativeCost = me.history.reduce((sum, h) => sum + h.cost, 0);

  // Incoming Orders / Demand card:
  //  - Retailer: exogenous customer demand THIS week
  //  - Others: engine's incomingOrder for THIS week
  const incomingLabel =
    role === "retailer"
      ? "Customer demand this week"
      : getIncomingFromLabel(role);

  const incomingValue =
    me.incomingOrder ??
    (role === "retailer"
      ? (() => {
          const demandIndex = Math.min(
            week - 1,
            config.customerDemand.length - 1
          );
          return config.customerDemand[demandIndex];
        })()
      : 0);

  const postItOrderValue =
    orderInput.trim() === "" ? undefined : parseInt(orderInput, 10);
  const hidePostItOrder =
    orderInput.trim() === "" || Number.isNaN(postItOrderValue);

  const outgoingPartner = getOutgoingPartnerLabel(role);
  const incomingPartner = getIncomingPartnerLabel(role);
  const upstreamPartnerName = getUpstreamPartnerName(role);
  const upstreamBacklog =
    partnerUpstream && partnerUpstream.backlog > 0
      ? partnerUpstream.backlog
      : 0;
  const showUpstreamBackorders =
    !!config.displayUpstreamBackorders && upstreamBacklog > 0;

  const hasBacklog = displayBacklog > 0;
  const isOverstocked = displayInventory > OVERSTOCK_THRESHOLD;
  const boardColumnsTemplate = "repeat(3, minmax(0, 1fr))";
  const boardColumnWidth = "calc((100% - 1.5rem) / 3)";
  const hasValidOrder = orderInput.trim() !== "" && !Number.isNaN(Number(orderInput));
  const submitDisabled = orderAlreadySubmitted || !canOrder || !connectionHealthy || !hasValidOrder;

  // Banner text per phase
  let bannerText: string | null = null;
  if (phase === 1) {
    bannerText = "Receiving Inventory";
  } else if (phase === 2) {
    bannerText = "Revealing Demand";
  } else if (phase === 3) {
    bannerText = "Shipping Inventory";
  }

  return (
    <div
      style={{
        padding: "0.75rem 0.5rem 1.1rem",
        background:
          "radial-gradient(circle at top, #fff7d1 0, #fdf3e0 45%, #f7e7c3 100%)",
      }}
    >
      <header
        style={{
          maxWidth: 960,
          margin: "0 auto 0.5rem",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
          alignItems: "start",
          gap: "0.9rem",
        }}
      >
        <div>
          <div style={{ fontSize: "0.9rem", color: "#8b5e00" }}>
            Beer Distribution Game
          </div>
          <h2 style={{ margin: "0.2rem 0" }}>
            🍺 Team <span style={{ color: "#8b5e00" }}>{team.name}</span>
          </h2>
          <div style={{ fontSize: "0.9rem", color: "#7a5a1f" }}>
            You are the{" "}
            <strong style={{ textTransform: "capitalize" }}>{role}</strong>
          </div>
          <div style={{ fontSize: "0.85rem", color: "#7a5a1f" }}>
            Player: <strong>{playerName}</strong>
          </div>
        </div>
        <section
          style={{
            width: 300,
            padding: "0.65rem 0.75rem",
            borderRadius: "0.75rem",
            border: "1px solid #ecd9aa",
            background: meterBlinkOn && isLastUndecidedHuman ? "#ffe9b5" : "#fff7e0",
            transition: "background 0.25s ease, box-shadow 0.25s ease",
            boxShadow:
              meterBlinkOn && isLastUndecidedHuman
                ? "0 0 0 2px rgba(240, 165, 0, 0.2)"
                : "none",
          }}
        >
          <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#8b5e00", textAlign: "center" }}>
            Team decisions this week
          </div>
          <div
            style={{
              marginTop: "0.3rem",
              fontSize: "0.95rem",
              color: "#5a3a00",
              textAlign: "center",
            }}
          >
            {progressNumerator}/{progressDenominator} submitted
          </div>
          <div
            style={{
              marginTop: "0.35rem",
              width: "100%",
              height: 10,
              borderRadius: 8,
              background: "#f2e3be",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${(progressNumerator / Math.max(1, progressDenominator)) * 100}%`,
                height: "100%",
                background: isLastUndecidedHuman ? "#e26d00" : "#4f8a10",
                transition: "width 0.2s ease",
              }}
            />
          </div>
          {isLastUndecidedHuman && (
            <div
              style={{
                marginTop: "0.35rem",
                color: "#b14c00",
                fontSize: "0.78rem",
                fontWeight: 600,
                textAlign: "center",
              }}
            >
              You are the last undecided teammate.
            </div>
          )}
        </section>
        <div
          style={{
            textAlign: "right",
            fontSize: "0.85rem",
            color: "#7a5a1f",
            justifySelf: "end",
          }}
        >
          <div>
            <strong>Your cumulative cost up to this week:</strong>{" "}
            ${myCumulativeCost.toFixed(2)}
          </div>
          <div>
            <strong>Total supply chain cost up to this week:</strong>{" "}
            ${supplyChainCostSoFar.toFixed(2)}
          </div>
          {lastRecord && (
            <div style={{ marginTop: "0.25rem" }}>
              <strong>Cost in last completed week:</strong> $
              {lastRecord.cost.toFixed(2)}
            </div>
          )}
        </div>
      </header>

      {/* Centered week banner */}
      <div
        style={{
          maxWidth: 960,
          margin: "0 auto 0.75rem",
          textAlign: "center",
          fontSize: "1.1rem",
          fontWeight: 700,
          letterSpacing: "0.08em",
          color: "#8b5e00",
          textTransform: "uppercase",
        }}
      >
        Week {week}
      </div>

      <main
        style={{
          maxWidth: 960,
          margin: "0 auto",
        }}
      >
        {/* Board: orders, inventory, pipelines */}
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            alignItems: "stretch",
            minHeight: 340,
          }}
          >
            {/* Top row: orders */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: boardColumnsTemplate,
              gap: "0.75rem",
              alignItems: "stretch",
            }}
          >
            <div
              style={{
                minWidth: 0,
                padding: "0.5rem",
                borderRadius: "0.75rem",
                background: "#fff7e0",
                border: "1px solid #ecd9aa",
              }}
            >
              <div
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  color: "#8b5e00",
                  marginBottom: "0.35rem",
                }}
              >
                Incoming Orders / Demand
              </div>
              <PostIt
                label={incomingLabel}
                value={incomingValue}
                hidden={!showIncomingOrder}
              />
            </div>
            <div
              style={{
                minWidth: 0,
                padding: "0.5rem",
                borderRadius: "0.75rem",
                background: "#fff7e0",
                border: "1px solid #ecd9aa",
              }}
            >
              <div
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  color: "#8b5e00",
                  marginBottom: "0.35rem",
                }}
              >
                {isFactory
                  ? "Production request (this week)"
                  : "Order you place (this week)"}
              </div>
              <PostIt
                label="Your new order"
                value={hidePostItOrder ? undefined : postItOrderValue}
                hidden={hidePostItOrder}
              />
            </div>
            <div
              style={{
                padding: "0.6rem",
                borderRadius: "0.75rem",
                background: "#fff7e0",
                border: "1px solid #ecd9aa",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                boxSizing: "border-box",
                width: "100%",
              }}
            >
              <div
                style={{
                  fontSize: "0.74rem",
                  fontWeight: 600,
                  color: "#8b5e00",
                  marginBottom: "0.3rem",
                }}
              >
                Place your order for week {week}
              </div>
              <input
                type="number"
                min={0}
                value={orderInput}
                onChange={(e) => setOrderInput(e.target.value)}
                disabled={orderAlreadySubmitted || !canOrder || !connectionHealthy}
                style={{
                  width: "100%",
                  padding: "0.3rem 0.45rem",
                  borderRadius: "0.45rem",
                  border: "1px solid #d6c094",
                  boxSizing: "border-box",
                  margin: "0 0 0.42rem",
                  display: "block",
                }}
              />
              <button
                onClick={handleSubmit}
                disabled={submitDisabled}
                style={{
                  width: "100%",
                  padding: "0.35rem 0.45rem",
                  borderRadius: "0.75rem",
                  border: "none",
                  boxSizing: "border-box",
                  fontSize: "0.84rem",
                  lineHeight: 1.2,
                  background: submitDisabled ? "#ccc" : "#f0a500",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: submitDisabled ? "default" : "pointer",
                  display: "block",
                }}
              >
                {orderAlreadySubmitted
                  ? "Order submitted – waiting for team"
                  : !connectionHealthy
                  ? "Reconnect to submit"
                  : canOrder
                  ? "Submit order"
                  : "Please wait for animations…"}
              </button>
            </div>
          </div>

          {/* Middle: inventory with left & right pipelines */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: boardColumnsTemplate,
              alignItems: "flex-start",
              gap: "0.75rem",
            }}
          >
            {/* LEFT COLUMN: outgoing / downstream pipeline */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "0.15rem",
                width: "100%",
              }}
            >
              {role !== "retailer" && (
                <>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      color: "#8b5e00",
                      fontWeight: 600,
                    }}
                  >
                    Outgoing shipments
                  </span>
                  {outgoingPartner && (
                    <span
                      style={{
                        fontSize: "0.65rem",
                        color: "#8b5e00",
                      }}
                    >
                      {outgoingPartner}
                    </span>
                  )}
                </>
              )}
              {partnerDownstream && (
                <>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                      marginTop: role !== "retailer" ? "0.2rem" : 0,
                    }}
                  >
                    <DelayBox
                      label="Delay 1"
                      value={displayDownDelay1}
                      highlight={phase === 3}
                    />
                    <span style={{ fontSize: "1.4rem" }}>⬅️</span>
                    <DelayBox
                      label="Delay 2"
                      value={displayDownDelay2}
                      highlight={phase === 3}
                    />
                  </div>
                  {/* Keep lane space reserved to avoid board height jumps */}
                  <TruckLane
                    progress={truckProgress}
                    visible={truckPhase === "shipping" && role !== "retailer"}
                  />
                </>
              )}
            </div>

            {/* CENTER: inventory */}
            <div
              style={{
                justifySelf: "center",
                padding: "1rem",
                minWidth: 180,
                borderRadius: "1.25rem",
                background: "#ffe9b5",
                boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.05)",
                textAlign: "center",
                transform:
                  phase === 1 || phase === 3 || phase === 4
                    ? "scale(1.03)"
                    : "scale(1)",
                transition: "transform 0.25s ease",
              }}
            >
              <div
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  color: "#8b5e00",
                  marginBottom: "0.25rem",
                }}
              >
                Inventory
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "flex-end",
                  gap: "0.25rem",
                }}
              >
                <span style={{ fontSize: "2rem" }}>
                  {isOverstocked ? "🏭" : "🍺"}
                </span>
                <span
                  style={{
                    fontSize: "2rem",
                    fontWeight: 700,
                    color: "#5a3a00",
                  }}
                >
                  {Math.round(displayInventory)}
                </span>
              </div>
              <div
                style={{
                  marginTop: "0.25rem",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  gap: "0.35rem",
                  fontSize: "0.8rem",
                  color: "#a02020",
                  visibility: hasBacklog ? "visible" : "hidden",
                }}
              >
                <span style={{ fontSize: "1.4rem" }}>😡</span>
                <span>Backlog: {Math.round(displayBacklog)}</span>
              </div>

              <div
                style={{
                  marginTop: "0.4rem",
                  fontSize: "0.8rem",
                  color: "#7a5a1f",
                }}
              >
                <div>Inventory cost: ${displayInvCost.toFixed(2)}</div>
                <div>Backlog cost: ${displayBacklogCost.toFixed(2)}</div>
              </div>
            </div>

            {/* RIGHT COLUMN: incoming pipeline */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "0.15rem",
                width: "100%",
              }}
            >
              <span
                style={{
                  fontSize: "0.7rem",
                  color: "#8b5e00",
                  fontWeight: 600,
                }}
              >
                {isFactory ? "Production pipeline" : "Incoming shipments"}
              </span>

              {isFactory ? (
                <span
                  style={{
                    fontSize: "0.65rem",
                    color: "#8b5e00",
                  }}
                >
                  from your own brewery
                </span>
              ) : (
                incomingPartner && (
                  <span
                    style={{
                      fontSize: "0.65rem",
                      color: "#8b5e00",
                    }}
                  >
                    {incomingPartner}
                  </span>
                )
              )}

              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  marginTop: "0.2rem",
                }}
              >
                <DelayBox
                  label="Delay 1"
                  value={displayInDelay1}
                  highlight={phase === 1 || phase === 3}
                />
                <span style={{ fontSize: "1.4rem" }}>⬅️</span>
                <DelayBox
                  label="Delay 2"
                  value={displayInDelay2}
                  highlight={phase === 1 || phase === 3}
                />
              </div>

              {/* Keep lane space reserved to avoid board height jumps */}
              <TruckLane
                progress={truckProgress}
                visible={truckPhase === "receiving"}
              />
            </div>
          </div>

          {showUpstreamBackorders && partnerUpstream && (
            <div
              style={{
                marginLeft: "auto",
                width: boardColumnWidth,
                padding: "0.75rem",
                borderRadius: "0.75rem",
                background: "#fff2f0",
                border: "1px solid #f3b4ad",
              }}
            >
              <div
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  color: "#8b5e00",
                  marginBottom: "0.25rem",
                }}
              >
                Units on backorder with your{" "}
                {upstreamPartnerName ? upstreamPartnerName : "supplier"}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "0.35rem",
                }}
              >
                <span
                  style={{
                    fontSize: "2rem",
                    fontWeight: 700,
                    color: "#a02020",
                  }}
                >
                  {upstreamBacklog}
                </span>
                <span style={{ color: "#7a5a1f", fontSize: "0.9rem" }}>
                  units
                </span>
              </div>
              <div
                style={{
                  fontSize: "0.85rem",
                  color: "#7a5a1f",
                  marginTop: "0.35rem",
                }}
              >
                Your upstream partner is currently behind on fulfilling shipments.
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Bottom blinking banner — always reserve space to avoid layout shift */}
      <div
        style={{
          maxWidth: 960,
          margin: "1rem auto 0",
          textAlign: "center",
          fontSize: "0.95rem",
          fontWeight: 600,
          color: "#8b5e00",
          opacity: bannerText ? (blinkOn ? 1 : 0.25) : 0,
          transition: "opacity 0.3s ease",
          minHeight: "1.5em",
        }}
      >
        {bannerText || "\u00A0"}
      </div>

      {showDisconnectOverlay && (
        <OverlayCard
          title="Connection lost"
          actions={[]}
        >
          {orderError || "Your connection to Firebase appears offline. Reconnect to continue and submit orders."}
        </OverlayCard>
      )}

      {/* Order clamped notice */}
      {showClampedNotice && (
        <OverlayCard
          title="Order adjusted to 0"
          onClose={() => setShowClampedNotice(false)}
          actions={[
            {
              label: "Got it",
              onClick: () => setShowClampedNotice(false),
              variant: "primary",
            },
          ]}
        >
          Your order cannot be negative. We set your order to 0 for this week.
        </OverlayCard>
      )}

      {/* High order confirmation */}
      {pendingHighOrder !== null && (
        <OverlayCard
          title="Large order entered"
          onClose={() => setPendingHighOrder(null)}
          actions={[
            {
              label: "Use this order",
              variant: "primary",
              onClick: () => {
                if (pendingHighOrder === null) return;
                setOrderInput(pendingHighOrder.toString());
                onSubmitOrder(pendingHighOrder);
                setPendingHighOrder(null);
              },
            },
            {
              label: "Revise order",
              onClick: () => setPendingHighOrder(null),
            },
          ]}
        >
          You entered an order of <strong>{pendingHighOrder}</strong>. Are you
          sure you want to submit this amount?
        </OverlayCard>
      )}
    </div>
  );
};

interface DelayBoxProps {
  label: string;
  value: number;
  highlight?: boolean;
}

const DelayBox: React.FC<DelayBoxProps> = ({ label, value, highlight }) => (
  <div
    style={{
      width: 70,
      height: 70,
      borderRadius: "0.85rem",
      border: "1px solid #ecd9aa",
      background: "#fff",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      transform: highlight ? "scale(1.05)" : "scale(1)",
      boxShadow: highlight ? "0 0 6px rgba(139,94,0,0.35)" : "none",
      transition: "transform 0.25s ease, box-shadow 0.25s ease",
    }}
  >
    <div
      style={{
        fontSize: "0.65rem",
        color: "#8b5e00",
        marginBottom: "0.1rem",
      }}
    >
      {label}
    </div>
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: "0.15rem",
      }}
    >
      <span style={{ fontSize: "1.2rem" }}>🍺</span>
      <span
        style={{
          fontSize: "1.2rem",
          fontWeight: 600,
          color: "#5a3a00",
        }}
      >
        {value}
      </span>
    </div>
  </div>
);

interface PostItProps {
  label: string;
  value?: number;
  hidden: boolean;
}

const PostIt: React.FC<PostItProps> = ({ label, value, hidden }) => (
  <div
    style={{
      position: "relative",
      width: "100%",
      height: 70,
      borderRadius: "0.75rem",
      background: "#ffe777",
      boxShadow: "0 2px 3px rgba(0,0,0,0.15)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      transition: "transform 0.35s ease",
    }}
  >
    <div
      style={{
        position: "absolute",
        top: 4,
        left: 8,
        fontSize: "0.6rem",
        color: "#6b4c00",
      }}
    >
      {label}
    </div>
    <div
      style={{
        fontSize: "1.5rem",
        fontWeight: 700,
        color: "#6b4c00",
      }}
    >
      {hidden ? "❓" : value}
    </div>
  </div>
);

interface OverlayAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
}

interface OverlayCardProps {
  title: string;
  onClose?: () => void;
  actions: OverlayAction[];
  children: React.ReactNode;
}

const OverlayCard: React.FC<OverlayCardProps> = ({
  title,
  onClose,
  actions,
  children,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    overlayRef.current?.focus();
    return () => { document.body.style.overflow = prev; };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && onClose) {
      onClose();
    }
  };

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 1000,
        outline: "none",
      }}
    >
      <div
        style={{
          minWidth: 280,
          maxWidth: 420,
          background: "#fffaf0",
          border: "1px solid #e2cfa0",
          borderRadius: "0.75rem",
          boxShadow: "0 8px 20px rgba(0,0,0,0.2)",
          padding: "1rem",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.5rem",
            gap: "0.5rem",
          }}
        >
          <h3 style={{ margin: 0, color: "#5a3a00" }}>{title}</h3>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                border: "1px solid #d6c094",
                borderRadius: "0.5rem",
                background: "#fff7e0",
                padding: "0.25rem 0.5rem",
                cursor: "pointer",
              }}
            >
              Close
            </button>
          )}
        </div>
        <div style={{ color: "#4a3513", fontSize: "0.95rem" }}>{children}</div>
        <div
          style={{
            marginTop: "0.75rem",
            display: "flex",
            gap: "0.5rem",
            justifyContent: "flex-end",
            flexWrap: "wrap",
          }}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              onClick={action.onClick}
              style={{
                padding: "0.4rem 0.75rem",
                borderRadius: "0.6rem",
                border: "1px solid #d6c094",
                background:
                  action.variant === "primary" ? "#f0a500" : "#fff7e0",
                color: action.variant === "primary" ? "#fff" : "#5a3a00",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

interface TruckLaneProps {
  progress: number; // 0 -> 1
  visible?: boolean;
}

/**
 * A simple horizontal truck lane: truck moves from right to left
 * across the lane over 2 seconds (driven by progress).
 */
const TruckLane: React.FC<TruckLaneProps> = ({ progress, visible = true }) => (
  <div
    style={{
      marginTop: "0.4rem",
      width: "100%",
      height: 24,
      position: "relative",
      overflow: "hidden",
    }}
  >
    <span
      style={{
        position: "absolute",
        bottom: 0,
        // Move from right (100%) to left (0%)
        left: `${(1 - progress) * 80}%`,
        fontSize: "1.4rem",
        transition: "none",
        opacity: visible ? 1 : 0,
      }}
    >
      🚚
    </span>
  </div>
);

// Label where incoming orders come from (for non-retailer)
function getIncomingFromLabel(role: Role): string {
  switch (role) {
    case "wholesaler":
      return "Orders from your Retailer";
    case "distributor":
      return "Orders from your Wholesaler";
    case "factory":
      return "Orders from your Distributor";
    default:
      return "Orders from your customer";
  }
}

// Text under "Outgoing shipments"
function getOutgoingPartnerLabel(role: Role): string | null {
  switch (role) {
    case "wholesaler":
      return "to your Retailer";
    case "distributor":
      return "to your Wholesaler";
    case "factory":
      return "to your Distributor";
    default:
      return null;
  }
}

// Text under "Incoming shipments" (retailer/wholesaler/distributor only)
function getIncomingPartnerLabel(role: Role): string | null {
  switch (role) {
    case "retailer":
      return "from your Wholesaler";
    case "wholesaler":
      return "from your Distributor";
    case "distributor":
      return "from your Factory";
    default:
      return null; // factory has production pipeline instead
  }
}

// Name of the upstream supplier (for the backorder display)
function getUpstreamPartnerName(role: Role): string | null {
  switch (role) {
    case "retailer":
      return "Wholesaler";
    case "wholesaler":
      return "Distributor";
    case "distributor":
      return "Factory";
    default:
      return null;
  }
}

function toGameStatus(value: unknown): GameSessionStatus | null {
  if (value === "lobby" || value === "in_progress" || value === "ended") {
    return value;
  }
  return null;
}

function toRole(value: unknown): Role | null {
  if (value === "retailer" || value === "wholesaler" || value === "distributor" || value === "factory") {
    return value;
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

function getStoredPlayerSession(): {
  gameCode: string | null;
  playerId: string | null;
  sessionToken: string | null;
} {
  if (typeof window === "undefined") {
    return {
      gameCode: null,
      playerId: null,
      sessionToken: null,
    };
  }

  return {
    gameCode: sessionStorage.getItem(PLAYER_GAME_CODE_KEY),
    playerId: sessionStorage.getItem(PLAYER_ID_KEY),
    sessionToken: sessionStorage.getItem(PLAYER_TOKEN_KEY),
  };
}

export default PlayerView;
