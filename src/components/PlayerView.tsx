// src/components/PlayerView.tsx
import React, { useEffect, useState, useRef } from "react";
import { db } from "../firebase";
import { doc, onSnapshot, updateDoc } from "firebase/firestore";
import { GameConfig, Role, TeamState, ROLES } from "../logic/gameModel";
import waitingBg from "../waitingscreen.png";

const PLAYER_GAME_CODE_KEY = "beerGame_player_gameCode";
const PLAYER_ID_KEY = "beerGame_player_playerId";
const PLAYER_ROLE_KEY = "beerGame_player_role";

interface PlayerData {
  id: string;
  name: string;
  teamId: string | null;
  role: Role | null;
  isRobot: boolean;
  teamName?: string | null;
}

type Phase = 0 | 1 | 2 | 3 | 4; // 1: receiving, 2: reveal demand, 3: shipping, 4: costs

const PlayerView: React.FC = () => {
  const [gameCode, setGameCode] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [gameStatus, setGameStatus] = useState<
    "lobby" | "in_progress" | "ended" | null
  >(null);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [player, setPlayer] = useState<PlayerData | null>(null);
  const [team, setTeam] = useState<TeamState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reattach session
  useEffect(() => {
    const code = localStorage.getItem(PLAYER_GAME_CODE_KEY);
    const pid = localStorage.getItem(PLAYER_ID_KEY);
    if (!code || !pid) {
      setError(
        "No active player session found. Please rejoin from the home screen."
      );
      return;
    }
    setGameCode(code);
    setPlayerId(pid);
  }, []);

  // Game subscription
  useEffect(() => {
    if (!gameCode) return;
    const gameRef = doc(db, "games", gameCode);
    const unsub = onSnapshot(gameRef, (snap) => {
      if (!snap.exists()) {
        setError("Game not found. It may have been deleted.");
        return;
      }
      const data = snap.data() as any;
      setGameStatus(data.status);
      setConfig(data.config as GameConfig);
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
      const d = snap.data() as any;
      const p: PlayerData = {
        id: snap.id,
        name: d.name,
        teamId: d.teamId ?? null,
        role: d.role ?? null,
        isRobot: d.isRobot ?? false,
        teamName: d.teamName ?? null,
      };
      setPlayer(p);
      if (d.role) {
        localStorage.setItem(PLAYER_ROLE_KEY, d.role);
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
      const data = snap.data() as any;
      setTeam({
        ...(data as TeamState),
        id: data.id ?? snap.id,
      });
    });
    return unsub;
  }, [gameCode, player?.teamId]);

  const handleSubmitOrder = async (order: number) => {
    if (!gameCode || !player?.teamId || !player.role) return;
    if (!team) return;
    if (team.ordersSubmitted && team.ordersSubmitted[player.role]) {
      return; // already submitted
    }

    const teamRef = doc(db, "games", gameCode, "teams", player.teamId);
    await updateDoc(teamRef, {
      [`pendingOrders.${player.role}`]: order,
      [`ordersSubmitted.${player.role}`]: true,
    });
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
              <TeamOrdersChart team={team} />
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
}

const PlayerBoard: React.FC<PlayerBoardProps> = ({
  team,
  role,
  playerName,
  config,
  onSubmitOrder,
  orderAlreadySubmitted,
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

  const [phase, setPhase] = useState<Phase>(0);
  const [canOrder, setCanOrder] = useState(false);

  // Incoming order card visibility
  const [showIncomingOrder, setShowIncomingOrder] = useState(false);

  // Blinking banner
  const [blinkOn, setBlinkOn] = useState(true);

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

    const phaseDuration = 2000; // ~2 seconds per main step
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

  const handleSubmit = () => {
    if (orderAlreadySubmitted || !canOrder) return;

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

    if (normalized > 50) {
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
    role === "retailer"
      ? (() => {
          const demandIndex = Math.min(
            week - 1,
            config.customerDemand.length - 1
          );
          return config.customerDemand[demandIndex];
        })()
      : me.incomingOrder;

  const postItOrderValue =
    orderInput.trim() === "" ? undefined : parseInt(orderInput, 10);
  const hidePostItOrder =
    orderInput.trim() === "" || Number.isNaN(postItOrderValue);

  const outgoingPartner = getOutgoingPartnerLabel(role);
  const incomingPartner = getIncomingPartnerLabel(role);

  const hasBacklog = displayBacklog > 0;
  const isOverstocked = displayInventory > 40;

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
        minHeight: "100vh",
        padding: "1rem 0.5rem 2rem",
        background:
          "radial-gradient(circle at top, #fff7d1 0, #fdf3e0 45%, #f7e7c3 100%)",
      }}
    >
      <header
        style={{
          maxWidth: 960,
          margin: "0 auto 0.5rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
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
        <div
          style={{
            textAlign: "right",
            fontSize: "0.85rem",
            color: "#7a5a1f",
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
          display: "grid",
          gridTemplateColumns: "1.2fr 2fr 1.2fr",
          gap: "0.75rem",
        }}
      >
        {/* LEFT: no communication */}
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          <div
            style={{
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
              No communication allowed ⚠️
            </div>
            <div style={{ fontSize: "0.75rem", color: "#7a5a1f" }}>
              You may not talk to your teammates. Act only on your own
              inventory, backlog, and orders. Your goal is to minimize the{" "}
              <strong>total</strong> supply chain cost.
            </div>
          </div>
        </section>

        {/* CENTER: Orders, inventory, pipelines */}
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            alignItems: "stretch",
          }}
        >
          {/* Top row: orders */}
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <div
              style={{
                flex: 1,
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
                flex: 1,
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
          </div>

          {/* Middle: inventory with left & right pipelines */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "0.75rem",
            }}
          >
            {/* LEFT COLUMN: outgoing / downstream pipeline */}
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "0.15rem",
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
                  {/* Truck lane for SHIPPING (left side) */}
                  {truckPhase === "shipping" && role !== "retailer" && (
                    <TruckLane progress={truckProgress} />
                  )}
                </>
              )}
            </div>

            {/* CENTER: inventory */}
            <div
              style={{
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
              {hasBacklog && (
                <div
                  style={{
                    marginTop: "0.25rem",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.8rem",
                    color: "#a02020",
                  }}
                >
                  <span style={{ fontSize: "1.4rem" }}>😡</span>
                  <span>Backlog: {Math.round(displayBacklog)}</span>
                </div>
              )}

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
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "0.15rem",
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

              {/* Truck lane for RECEIVING (right side) */}
              {truckPhase === "receiving" && (
                <TruckLane progress={truckProgress} />
              )}
            </div>
          </div>
        </section>

        {/* RIGHT: order input */}
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-start",
            gap: "0.75rem",
          }}
        >
          <div
            style={{
              padding: "0.75rem",
              borderRadius: "0.75rem",
              background: "#fff7e0",
              border: "1px solid #ecd9aa",
            }}
          >
            <div
              style={{
                fontSize: "0.8rem",
                fontWeight: 600,
                color: "#8b5e00",
                marginBottom: "0.35rem",
              }}
            >
              Place your order for week {week}
            </div>
            <input
              type="number"
              min={0}
              value={orderInput}
              onChange={(e) => setOrderInput(e.target.value)}
              disabled={orderAlreadySubmitted || !canOrder}
              style={{
                width: "80%",
                padding: "0.35rem 0.5rem",
                borderRadius: "0.5rem",
                border: "1px solid #d6c094",
                margin: "0 auto 0.5rem",
                display: "block",
              }}
            />
            <button
              onClick={handleSubmit}
              disabled={orderAlreadySubmitted || !canOrder}
              style={{
                width: "80%",
                padding: "0.4rem 0.5rem",
                borderRadius: "0.75rem",
                border: "none",
                background:
                  orderAlreadySubmitted || !canOrder ? "#ccc" : "#f0a500",
                color: "#fff",
                fontWeight: 600,
                cursor:
                  orderAlreadySubmitted || !canOrder ? "default" : "pointer",
                margin: "0 auto",
                display: "block",
              }}
            >
              {orderAlreadySubmitted
                ? "Order submitted – waiting for team"
                : canOrder
                ? "Submit order"
                : "Please wait for animations…"}
            </button>
          </div>
        </section>
      </main>

      {/* Bottom blinking banner */}
      {bannerText && (
        <div
          style={{
            maxWidth: 960,
            margin: "1rem auto 0",
            textAlign: "center",
            fontSize: "0.95rem",
            fontWeight: 600,
            color: "#8b5e00",
            opacity: blinkOn ? 1 : 0.25,
            transition: "opacity 0.3s ease",
          }}
        >
          {bannerText}
        </div>
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
}) => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.35)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "1rem",
      zIndex: 1000,
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

interface TruckLaneProps {
  progress: number; // 0 -> 1
}

/**
 * A simple horizontal truck lane: truck moves from right to left
 * across the lane over 2 seconds (driven by progress).
 */
const TruckLane: React.FC<TruckLaneProps> = ({ progress }) => (
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

// --- Simple SVG line chart for per-team order histories (same as host) ---

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

export default PlayerView;
