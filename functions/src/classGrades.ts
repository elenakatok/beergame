// functions/src/classGrades.ts — THE BEER GAME GRADES ITS OWN CLASS.
//
// Guest_Owned_Grading_Spec_Addendum_v1.md G1 — "The guest owns grading completely. It returns
// finished grades. The matcher does not compute, adjust, normalize or default them."
//
// Pure, so it can be proved without Firestore (getClassGrades in classroom.ts does the reads).
//
// ⚠ THIS IS A RELOCATION, NOT A NEW GRADE. Until this pass the matcher computed this z in its
// scoreAndRecord (mygames-matcher functions/src/scoring.ts cohortScore, deleted with this
// pass). The algorithm below is that one, step for step — INCLUDING THE ORDER in which team
// costs are pooled, because a floating-point sum depends on its order and the requirement is
// bit-for-bit equality with the grades already in the gradebook:
//   • sessions in the order the matcher lists them (its group-id order);
//   • within a session, players in document order, each team pooled at its first player;
//   • one outcome per team: the team's total supply-chain cost;
//   • population mean and standard deviation; z = −(teamCost − mean) / std, rounded to 4 dp;
//     std 0 (every team equal) → every z is 0;
//   • a grade exists only for a player who claimed their seat — otherwise the value is null.
// LOWER total cost is the better team, so it gets the positive z. All four roles pool together:
// on team cost a Retailer and a Factory are genuinely comparable (they share one number).

export const GRADE_LABEL = "Team cost z-score (lower cost is better)";

export interface GradeSessionInput {
  gameCode: string;
  teams: Array<{ teamId: string; data: Record<string, unknown> }>;
  players: Array<Record<string, unknown>>;
}

export interface ClassGradeRow {
  studentId: string;
  value: number | null;
  label: string;
}

export function gradeClass(sessions: GradeSessionInput[]): ClassGradeRow[] {
  // The same player rows getClassResults builds: humans with a classroom identity.
  const people: Array<{
    gameCode: string; studentId: string; teamId: unknown; teamCost: number | null; participated: boolean;
  }> = [];
  for (const s of sessions) {
    const teamCostById = new Map(s.teams.map((t) => [t.teamId, Number(t.data.totalCost ?? 0)]));
    for (const d of s.players) {
      if (typeof d.classroomStudentId !== "string" || d.isRobot === true) continue;
      people.push({
        gameCode: s.gameCode,
        studentId: d.classroomStudentId,
        teamId: d.teamId ?? null,
        teamCost: typeof d.teamId === "string" ? (teamCostById.get(d.teamId) ?? null) : null,
        participated: d.lastHeartbeatAt != null,
      });
    }
  }

  // One data point per team that has a human, keyed per session (team ids repeat across sessions).
  const pool = new Map<string, number>();
  for (const p of people) {
    if (p.teamId != null && typeof p.teamCost === "number") pool.set(`${p.gameCode}:${String(p.teamId)}`, p.teamCost);
  }
  const outcomes = [...pool.values()];
  const n = outcomes.length;
  const mean = n ? outcomes.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n ? outcomes.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  const std = Math.sqrt(variance);
  const sign = -1; // lower cost is better
  const zFor = (v: number): number => (std > 0 ? Number(((sign * (v - mean)) / std).toFixed(4)) + 0 : 0);

  return people.map((p) => ({
    studentId: p.studentId,
    value: p.participated && typeof p.teamCost === "number" ? zFor(p.teamCost) : null,
    label: GRADE_LABEL,
  }));
}
