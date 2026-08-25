// functions/src/classroomResults.ts
//
// CLASSROOM GRADEBOOK PUSH (Workstream C).
//
// When a classroom-provisioned session ends, push one result per human student
// back to the classroom gradebook, using the same contract as every other game
// (POST { game_instance_id, participant_id, status, role, normalized_score,
// knowledge_check_score, details } with Authorization: Bearer <secret>, retry on
// 5xx). Grade is PARTICIPATION (product decision #7): a student who showed up and
// played gets full credit; an assigned student who never opened their link is a
// no_show. Performance (team cost, bullwhip) travels in `details` for reports —
// it never drives the grade. Knowledge-check score is null (KC deferred, #9).
//
// The push is automatic: a Firestore trigger fires the moment the game doc's
// status transitions to "ended" (whether the server auto-ended it or an
// instructor ended it), so no host action is required.
//
// Config: CLASSROOM_CALLBACK_URL (env, functions/.env) + CLASSROOM_CALLBACK_SECRET
// (secret). When either is absent the push is a no-op (standalone mode).

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { ROLES, Role } from "./engine";

const CLASSROOM_CALLBACK_SECRET = defineSecret("CLASSROOM_CALLBACK_SECRET");
const db = () => admin.firestore();

interface GameResult {
  game_instance_id: string;
  participant_id: string;
  status: "completed" | "no_show" | "partial" | "excluded";
  role: string | null;
  normalized_score: number | null;
  knowledge_check_score: number | null;
  details: Record<string, unknown>;
}

async function postResult(result: GameResult, url: string, secret: string): Promise<void> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(result),
  });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`HTTP ${r.status}`);
}

async function dispatchResults(
  records: GameResult[],
  url: string,
  secret: string
): Promise<{ total: number; succeeded: number; failed: Array<{ participant_id: string; reason: string }> }> {
  const retryDelays = [300, 800];
  let succeeded = 0;
  const failed: Array<{ participant_id: string; reason: string }> = [];
  for (const rec of records) {
    let ok = false;
    let reason = "";
    for (let attempt = 0; attempt <= retryDelays.length && !ok; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelays[attempt - 1]));
      try {
        await postResult(rec, url, secret);
        ok = true;
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
        const m = /HTTP (\d+)/.exec(reason);
        if (m && parseInt(m[1], 10) < 500) break; // 4xx — fail fast, no retry
      }
    }
    if (ok) succeeded += 1;
    else failed.push({ participant_id: rec.participant_id, reason });
  }
  return { total: records.length, succeeded, failed };
}

/** Population std-dev of a role's placed orders — the per-role variability the bullwhip chart shows. */
function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export const onGameEndedPushResults = onDocumentWritten(
  { document: "games/{gameCode}", secrets: [CLASSROOM_CALLBACK_SECRET], region: "us-central1" },
  async (event) => {
    const after = event.data?.after;
    if (!after || !after.exists) return;
    const afterData = after.data() as Record<string, unknown>;
    const beforeData = event.data?.before?.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;

    // Only on the transition INTO "ended", and only for classroom-provisioned sessions.
    if (afterData.status !== "ended" || beforeData?.status === "ended") return;
    if (afterData.source !== "classroom") return;

    // ⚠ GRADING MOVED TO THE MATCHER. A matcher session's teams live in SEPARATE Beer Game
    // games, so this per-game push can only ever see one team and cannot compute the
    // cross-team z-score. The matcher's scoreAndRecord reads every team's cost (getClassResults)
    // and pushes the z-scored gradebook itself. This per-game participation push would CLOBBER
    // that (a late game-end overwriting the matcher's z-score), so it is disabled by default.
    // Set BEERGAME_SELF_GRADE=true only if the Beer Game is ever hosted WITHOUT the matcher.
    if (process.env.BEERGAME_SELF_GRADE !== "true") return;

    const gameCode = (event.params as { gameCode: string }).gameCode;
    const instanceId =
      typeof afterData.classroomInstanceId === "string" && afterData.classroomInstanceId
        ? afterData.classroomInstanceId
        : gameCode;

    const url = process.env.CLASSROOM_CALLBACK_URL ?? "";
    const secret = CLASSROOM_CALLBACK_SECRET.value() ?? "";
    if (!url || !secret) {
      logger.warn("[classroomResults] callback URL/secret not configured — skipping push", { gameCode });
      return;
    }

    const gameRef = db().collection("games").doc(gameCode);
    const [playersSnap, teamsSnap] = await Promise.all([
      gameRef.collection("players").get(),
      gameRef.collection("teams").get(),
    ]);

    const teams = new Map<string, Record<string, unknown>>();
    for (const t of teamsSnap.docs) teams.set(t.id, t.data());

    const records: GameResult[] = [];
    for (const p of playersSnap.docs) {
      const d = p.data() as Record<string, unknown>;
      const studentId = typeof d.classroomStudentId === "string" ? d.classroomStudentId : null;
      if (!studentId || d.isRobot === true) continue; // only classroom human players are graded

      const role = (typeof d.role === "string" ? d.role : null) as Role | null;
      const participated = d.lastHeartbeatAt != null; // resumed/played at least once
      const team = typeof d.teamId === "string" ? teams.get(d.teamId) : undefined;

      const details: Record<string, unknown> = {};
      if (team) {
        details.team_name = team.name ?? null;
        details.team_total_cost = team.totalCost ?? null;
        const stages = (team.stages ?? {}) as Record<string, { history?: Array<{ orderPlaced?: number }> }>;
        // Per-role order-variability (the bullwhip metric the report charts) for context.
        const roleStdDev: Record<string, number> = {};
        for (const r of ROLES) {
          const hist = stages[r]?.history ?? [];
          roleStdDev[r] = Number(stdDev(hist.map((h) => Number(h.orderPlaced ?? 0))).toFixed(3));
        }
        details.role_order_stddev = roleStdDev;
      }

      records.push({
        game_instance_id: instanceId,
        participant_id: studentId,
        status: participated ? "completed" : "no_show",
        role,
        normalized_score: participated ? 1 : null, // participation = full credit (#7)
        knowledge_check_score: null, // KC deferred (#9)
        details,
      });
    }

    const summary = await dispatchResults(records, url, secret);
    logger.info("[classroomResults] pushed beergame results", { gameCode, instanceId, ...summary });
  }
);
