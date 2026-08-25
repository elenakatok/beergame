import React, { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { ROLES, TeamState, WeekRecord } from "../logic/gameModel";
import { computeBullwhip } from "../logic/endgameAnalytics";
import TeamOrdersLineChart from "./charts/TeamOrdersLineChart";

// ═══════════════════════════════════════════════════════════════════════════════
// ClassReportView — a READ-ONLY report for one classroom Beer Game session, reachable at
// /?report=<gameCode>. The matcher's instructor dashboard links here per group.
//
// Reads the game's teams straight from Firestore with NO auth: a classroom game is
// "public-readable" by the rules (ownerInstructorId set, status in lobby/in_progress/ended,
// not expired), so an instructor who is not signed into the Beer Game can still open it.
//
// Shows, per team (a matched group): orders over time and inventory over time for the four
// supply-chain roles, plus total supply-chain cost and the bullwhip ratio. The charts reuse
// the game's own TeamOrdersLineChart (parametrised to plot inventory as well as orders).
// ═══════════════════════════════════════════════════════════════════════════════

function maxOf(team: TeamState, valueFor: (h: WeekRecord) => number, floor: number): number {
  let m = floor;
  for (const role of ROLES) {
    for (const h of team.stages[role].history || []) m = Math.max(m, valueFor(h) || 0);
  }
  // Round up to a tidy axis top.
  return Math.ceil(m / 5) * 5 || floor;
}

export default function ClassReportView({ gameCode }: { gameCode: string }) {
  const [teams, setTeams] = useState<TeamState[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ref = collection(db, "games", gameCode, "teams");
    const unsub = onSnapshot(
      ref,
      (snap) => setTeams(snap.docs.map((d) => d.data() as TeamState)),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
    return () => unsub();
  }, [gameCode]);

  const inventoryOf = useMemo(() => (h: WeekRecord) => h.inventoryEnd ?? 0, []);
  const ordersOf = useMemo(() => (h: WeekRecord) => h.orderPlaced ?? 0, []);

  const wrap: React.CSSProperties = { maxWidth: 900, margin: "0 auto", padding: "1.5rem", fontFamily: "system-ui, sans-serif" };

  if (error) {
    return <main style={wrap}><h1>Report</h1><p style={{ color: "#b91c1c" }}>Could not load this session: {error}</p></main>;
  }
  if (!teams) return <main style={wrap}><p>Loading report…</p></main>;
  if (teams.length === 0) {
    return <main style={wrap}><h1>Report — {gameCode}</h1><p>No teams have played in this session yet.</p></main>;
  }

  return (
    <main style={wrap}>
      <h1 style={{ marginBottom: "0.25rem" }}>Beer Game report</h1>
      <p style={{ color: "#666", marginTop: 0 }}>Session {gameCode} · orders and inventory over time by group.</p>

      {teams.map((team, i) => {
        const bw = computeBullwhip(team);
        const ordersMax = maxOf(team, ordersOf, 25);
        const invMax = maxOf(team, inventoryOf, 25);
        return (
          <section
            key={i}
            style={{ margin: "1.25rem 0", padding: "1rem 1.25rem", border: "1px solid #e5e5e5", borderRadius: 10, background: "#fff" }}
          >
            <h2 style={{ marginTop: 0 }}>🍺 {team.name}</h2>
            <p style={{ color: "#555", marginTop: 0 }}>
              Total supply-chain cost: <strong>${(team.totalCost ?? 0).toFixed(2)}</strong>
              {bw != null && <> · Bullwhip ratio: <strong>{bw.toFixed(2)}</strong></>}
              {" "}· {team.humanCount ?? 0} human player{(team.humanCount ?? 0) === 1 ? "" : "s"}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1.5rem" }}>
              <div style={{ flex: "1 1 320px", minWidth: 300 }}>
                <h3 style={{ margin: "0 0 0.25rem", fontSize: "0.95rem" }}>Orders placed over time</h3>
                <TeamOrdersLineChart team={team} metricLabel="Orders" valueFor={ordersOf} maxY={ordersMax} />
              </div>
              <div style={{ flex: "1 1 320px", minWidth: 300 }}>
                <h3 style={{ margin: "0 0 0.25rem", fontSize: "0.95rem" }}>Inventory over time</h3>
                <TeamOrdersLineChart team={team} metricLabel="Inventory" valueFor={inventoryOf} maxY={invMax} />
              </div>
            </div>
          </section>
        );
      })}
    </main>
  );
}
