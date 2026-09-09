// functions/src/classroom.ts
//
// CLASSROOM BRIDGE (Workstream B, "clean guest" option).
//
// The Beer Game keeps its own teams/players model. The classroom platform owns
// identity, roster, and matching (students into groups of 4). This thin bridge
// translates a set of matched groups into role-assigned Beer Game teams and lets
// each student land directly in their seat via a deep link — without the Beer
// Game adopting the platform's shared seat/grouping machinery.
//
// Two entry points:
//   • provisionClassSession  (server-to-server, secret-authed HTTPS): classroom
//     posts the matched groups; we create ONE session per class, build a team per
//     group with the four supply-chain roles assigned, bot-fill absent seats
//     (product decision #8), and return per-student seat info for deep links.
//   • resumeClassPlayer      (student-facing, plain HTTP): the deep-linked student
//     exchanges a SIGNED SEAT TOKEN for their pre-assigned seat (playerId / role /
//     sessionToken), which drives the existing PlayerView. No Firebase auth, no shared
//     secret in the browser — the token the matcher minted is the whole credential (D2/D3).
//
// This file is additive and self-contained (no edits to Enno's index.ts beyond a
// re-export), to keep merges with upstream cheap.

import { onRequest, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import * as crypto from "crypto";
import * as logger from "firebase-functions/logger";
import {
  createInitialTeamState,
  defaultConfig,
  ROLES,
  Role,
  GameConfig,
} from "./engine";
import { pickTeamName } from "./teamNames";
import { verifySeatToken } from "./seatToken";

const CLASSROOM_PROVISION_SECRET = defineSecret("CLASSROOM_PROVISION_SECRET");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const db = () => admin.firestore();

// ── CONTRACT v1 (spec D7, D8) ─────────────────────────────────────────────────
//
// D7 — "Every matcher→guest request carries contract_version, and the guest rejects an
// unknown major. Echoed in every response. Starts at 1."
// D8 — "Errors are structured JSON with a stable machine-readable code, on every status
// including 500. HttpsError must not escape an onRequest handler."
//
// ⚠ D1: no compatibility shim. An ABSENT contract_version is a rejection, exactly like a
// wrong one — there is no unversioned path. No real student has run through this contract,
// so there is nothing to migrate, and a shim would outlive the reason for it.
//
// ⚠ ALL FOUR endpoints now carry contract_version. Pass A covered the three
// server-to-server ones and deliberately excluded resumeClassPlayer because it was then a
// student→guest callable rather than a matcher→guest surface; D3 changed that surface, so
// the exclusion ended with it.

export const CONTRACT_VERSION = 1;

/**
 * Stable, machine-readable error codes. These are part of the contract: a third-party
 * implementation is expected to emit the same strings, and the conformance harness asserts
 * them. Add codes; do not rename or repurpose them.
 */
type ContractErrorCode =
  | "METHOD_NOT_ALLOWED"
  | "UNAUTHORIZED"
  | "CONTRACT_VERSION_REQUIRED"
  | "UNSUPPORTED_CONTRACT_VERSION"
  | "GROUPS_REQUIRED"
  | "INVALID_GAME_CODE"
  | "NOT_FOUND"
  | "NOT_A_CLASSROOM_SESSION"
  | "CODE_ALLOCATION_FAILED"
  | "INTERNAL"
  // ── D2/D3 seat-claim surface ──
  | "STUDENT_ID_REQUIRED"
  | "SEAT_TOKEN_REQUIRED"
  | "SEAT_TOKEN_MALFORMED"
  | "SEAT_TOKEN_INVALID"
  | "SEAT_TOKEN_EXPIRED"
  | "SEAT_NOT_FOUND"
  | "SEAT_LOCK_INVALID"
  | "SEAT_PLAYER_MISSING";

/** Every error body: structured, coded, and carrying the version — including 500s. */
function sendError(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  status: number,
  code: ContractErrorCode,
  message: string,
): void {
  res.status(status).json({ contract_version: CONTRACT_VERSION, error: { code, message } });
}

/** Every success body echoes the version alongside its own fields. */
function sendOk(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  payload: Record<string, unknown>,
): void {
  res.status(200).json({ contract_version: CONTRACT_VERSION, ...payload });
}

/**
 * D7's gate. Returns null when the request may proceed, or the error to send.
 * Absent is rejected as firmly as unknown — see the D1 note above.
 */
function contractVersionError(
  body: Record<string, unknown>,
): { code: ContractErrorCode; message: string } | null {
  const raw = body["contract_version"];
  if (raw === undefined || raw === null) {
    return {
      code: "CONTRACT_VERSION_REQUIRED",
      message: `contract_version is required and must be ${CONTRACT_VERSION}.`,
    };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n !== CONTRACT_VERSION) {
    return {
      code: "UNSUPPORTED_CONTRACT_VERSION",
      message: `contract_version ${String(raw)} is not supported; this guest speaks ${CONTRACT_VERSION}.`,
    };
  }
  return null;
}

/**
 * Pure game-code validation — no throwing, so an onRequest handler can turn a bad code into
 * a structured 400 instead of letting an HttpsError escape as an unstructured 500 (D8).
 * ⚠ Production was observed on 2026-09-09 returning HTTP 500 with a non-JSON body
 * "Internal Server Error" for the code BEER01. That is precisely what this removes.
 */
function validateGameCode(raw: unknown): { ok: true; code: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "gameCode is required." };
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z2-9]{4,8}$/.test(code)) return { ok: false, message: "Invalid game code." };
  return { ok: true, code };
}

// ── small local helpers (kept here so this file stays self-contained) ─────────
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function newSessionToken(): string {
  return crypto.randomBytes(24).toString("hex");
}
function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").replaceAll("/", "_");
}
// ⚠ parseGameCode (the HttpsError-throwing wrapper) and requireAuthUid are GONE. They
// existed only for resumeClassPlayer while it was an onCall; D3 made it plain HTTP, so
// every handler in this file now uses validateGameCode and returns structured errors.
function sanitizeConfig(input: unknown): GameConfig {
  const base = defaultConfig();
  if (!input || typeof input !== "object") return base;
  const c = input as Partial<GameConfig>;
  const nWeeks = Math.max(1, Math.round(Number(c.nWeeks ?? base.nWeeks)));
  return {
    nWeeks,
    inventoryCost: Math.max(0, Number(c.inventoryCost ?? base.inventoryCost)),
    backlogCost: Math.max(0, Number(c.backlogCost ?? base.backlogCost)),
    customerDemand:
      Array.isArray(c.customerDemand) && c.customerDemand.length === nWeeks
        ? c.customerDemand.map((n) => Number(n))
        : Array.from({ length: nWeeks }, (_, i) => (i < 4 ? 4 : 8)),
    extraOrderDelay: Boolean(c.extraOrderDelay),
    displayUpstreamBackorders: Boolean(c.displayUpstreamBackorders),
  };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // subset of [A-Z2-9], no confusables
async function generateUniqueGameCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    const snap = await db().collection("games").doc(code).get();
    if (!snap.exists) return code;
  }
  throw new HttpsError("internal", "Could not allocate a game code.");
}

function bearerMatches(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface ProvisionMember {
  studentId: string;
  displayName?: string;
}
interface ProvisionGroup {
  groupId?: string;
  members: ProvisionMember[];
}

/**
 * provisionClassSession — server-to-server. Classroom posts:
 *   { config?: Partial<GameConfig>, groups: [{ groupId?, members: [{ studentId, displayName? }] }] }
 * We create one session per class, one team per group (roles shuffled onto the
 * present members, absent seats bot-filled), and return { gameCode, seats }.
 * Auth: Authorization: Bearer <CLASSROOM_PROVISION_SECRET>.
 */
export const provisionClassSession = onRequest(
  { secrets: [CLASSROOM_PROVISION_SECRET], cors: true, maxInstances: 20 },
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "This endpoint accepts POST only.");
      return;
    }
    if (!bearerMatches(req.headers.authorization, CLASSROOM_PROVISION_SECRET.value())) {
      sendError(res, 401, "UNAUTHORIZED", "A valid provisioning secret is required.");
      return;
    }

    const body = (req.body ?? {}) as { config?: unknown; groups?: unknown; instanceId?: unknown };

    const vErr = contractVersionError(body as Record<string, unknown>);
    if (vErr) {
      sendError(res, 400, vErr.code, vErr.message);
      return;
    }

    const groups = Array.isArray(body.groups) ? (body.groups as ProvisionGroup[]) : null;
    if (!groups || groups.length === 0) {
      sendError(res, 400, "GROUPS_REQUIRED", "groups[] is required and must be non-empty.");
      return;
    }
    // The classroom's game_instances/<id> — used as game_instance_id when results
    // are pushed back to the gradebook. Falls back to the game code if absent.
    const classroomInstanceId =
      typeof body.instanceId === "string" && body.instanceId.trim() ? body.instanceId.trim() : null;

    const config = sanitizeConfig(body.config);

    // ⚠ D8: everything from here down runs inside a try. generateUniqueGameCode throws an
    // HttpsError on exhaustion, and an HttpsError escaping an onRequest surfaces as an
    // unstructured 500 — the exact shape this pass removes. Any unexpected throw (a
    // Firestore write failing mid-batch, say) also lands as a coded 500 rather than a
    // bare "Internal Server Error".
    try {
    const code = await generateUniqueGameCode();
    const now = Timestamp.now();
    const expiresAt = Timestamp.fromMillis(now.toMillis() + THIRTY_DAYS_MS);
    const gameRef = db().collection("games").doc(code);

    const batch = db().batch();
    batch.set(gameRef, {
      status: "in_progress",
      createdAt: FieldValue.serverTimestamp(),
      startedAt: FieldValue.serverTimestamp(),
      expiresAt,
      ownerInstructorId: "classroom",
      source: "classroom",
      classroomInstanceId,
      config,
      humanJoinCount: 0,
    });

    const seats: Array<{
      studentId: string;
      role: Role;
      teamId: string;
      playerId: string;
      groupId: string;
    }> = [];

    // Friendly, on-theme team names ("Hoppy Campers") instead of the raw matcher group
    // UUID. `usedTeamNames` keeps them distinct across the groups in this call. The real
    // matcher group id is preserved separately (see `groupId` on each seat below) — it is
    // NOT the display name, and grade attribution keys on classroomStudentId regardless.
    const usedTeamNames = new Set<string>();

    groups.forEach((group, gi) => {
      const teamId = `team${gi + 1}`;
      const teamName = pickTeamName(gi, usedTeamNames);
      const realGroupId =
        typeof group.groupId === "string" && group.groupId.trim()
          ? group.groupId.trim()
          : `group-${gi + 1}`;
      const team = createInitialTeamState(teamId, teamName);

      const members = Array.isArray(group.members) ? group.members.slice(0, ROLES.length) : [];
      // Shuffle role order so seat assignment is fair across a class.
      const roleOrder = [...ROLES];
      for (let i = roleOrder.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1);
        [roleOrder[i], roleOrder[j]] = [roleOrder[j], roleOrder[i]];
      }

      members.forEach((m, mi) => {
        const role = roleOrder[mi];
        const studentId = String(m?.studentId ?? "").trim();
        if (!role || !studentId) return;
        const displayName = String(m?.displayName ?? studentId).trim() || studentId;

        const playerRef = gameRef.collection("players").doc();
        batch.set(playerRef, {
          name: displayName,
          normalizedName: normalizeName(displayName),
          classroomStudentId: studentId,
          createdAt: FieldValue.serverTimestamp(),
          isRobot: false,
          sessionTokenHash: null,
          lastHeartbeatAt: null,
          removedAt: null,
          removedBy: null,
          teamId,
          role,
          teamName,
        });
        // Deep-link resume lock: classroom studentId → this seat.
        batch.set(gameRef.collection("classroomPlayers").doc(studentId), {
          playerId: playerRef.id,
          teamId,
          role,
        });

        team.stages[role].playerId = playerRef.id;
        team.stages[role].playerName = displayName;
        team.stages[role].isRobot = false;
        team.humanCount += 1;
        seats.push({ studentId, role, teamId, playerId: playerRef.id, groupId: realGroupId });
      });

      // Bot-fill any seat with no present student (product decision #8).
      for (const role of ROLES) {
        if (team.stages[role].playerId == null) {
          team.stages[role].playerId = null;
          team.stages[role].playerName = "Beer GPT";
          team.stages[role].isRobot = true;
        }
      }

      batch.set(gameRef.collection("teams").doc(teamId), team);
    });

    await batch.commit();
    logger.info("provisionClassSession created", { gameCode: code, groups: groups.length, seats: seats.length });
    sendOk(res, { gameCode: code, seats });
    } catch (err) {
      const isExhausted = err instanceof HttpsError && err.code === "internal";
      logger.error("provisionClassSession failed", { err: String(err) });
      sendError(
        res,
        500,
        isExhausted ? "CODE_ALLOCATION_FAILED" : "INTERNAL",
        isExhausted ? "Could not allocate a game code." : "Provisioning failed.",
      );
    }
  }
);

/**
 * finalizeClassSession — server-to-server (same secret as provisioning). Ends a
 * classroom session, whether or not every team finished (students may leave a
 * live class before the last week). Setting status → "ended" fires the
 * onGameEndedPushResults trigger, which pushes participation to the gradebook.
 * The server also auto-ends a session when every team completes on its own; this
 * is the explicit control the classroom dashboard uses to finalize early.
 */
export const finalizeClassSession = onRequest(
  { secrets: [CLASSROOM_PROVISION_SECRET], cors: true, maxInstances: 20 },
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "This endpoint accepts POST only.");
      return;
    }
    if (!bearerMatches(req.headers.authorization, CLASSROOM_PROVISION_SECRET.value())) {
      sendError(res, 401, "UNAUTHORIZED", "A valid provisioning secret is required.");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vErr = contractVersionError(body);
    if (vErr) {
      sendError(res, 400, vErr.code, vErr.message);
      return;
    }
    // ⚠ D8: validateGameCode instead of parseGameCode — a bad code is a structured 400,
    // never an HttpsError escaping as an unstructured 500.
    const parsed = validateGameCode(body.gameCode);
    if (!parsed.ok) {
      sendError(res, 400, "INVALID_GAME_CODE", parsed.message);
      return;
    }
    const gameCode = parsed.code;
    try {
      const gameRef = db().collection("games").doc(gameCode);
      const snap = await gameRef.get();
      if (!snap.exists) {
        sendError(res, 404, "NOT_FOUND", "No session with that game code.");
        return;
      }
      const data = snap.data() as Record<string, unknown>;
      if (data.source !== "classroom") {
        sendError(res, 403, "NOT_A_CLASSROOM_SESSION", "That session was not provisioned by the classroom.");
        return;
      }
      if (data.status === "ended") {
        sendOk(res, { ok: true, alreadyEnded: true });
        return;
      }
      await gameRef.update({ status: "ended", endedAt: FieldValue.serverTimestamp() });
      logger.info("finalizeClassSession ended session", { gameCode });
      sendOk(res, { ok: true });
    } catch (err) {
      logger.error("finalizeClassSession failed", { gameCode, err: String(err) });
      sendError(res, 500, "INTERNAL", "Finalizing the session failed.");
    }
  }
);

/**
 * resumeClassPlayer — the deep-linked student exchanges a SIGNED SEAT TOKEN for their
 * pre-assigned seat. Mints a fresh beergame session token, exactly like joinOrResumePlayer's
 * reconnect path, so the existing PlayerView + submitPlayerOrder work unchanged.
 *
 * D3 — "The seat claim becomes plain HTTP with the shared secret, and stops being a Firebase
 * callable. Today resumeClassPlayer is an onCall requiring an anonymous Firebase uid. That
 * uid identifies nobody — it exists only so the endpoint has some auth — and it binds every
 * guest game to Firebase. Once D2 supplies real proof of identity, the anonymous login has
 * no job left. After this change the entire contract is stack-agnostic HTTP."
 *
 * ⚠ THE STUDENT DOES NOT CARRY THE SHARED SECRET — it signs the token, it is never sent.
 * The browser presents only the HMAC the matcher minted for that one seat. There is no
 * Authorization header on this endpoint: the seat token IS the credential. That is what
 * makes the whole contract implementable without Firebase.
 *
 * ⚠ D1: no unsigned fallback. A missing, malformed, wrong or expired token is a refusal,
 * never a downgrade to the old behaviour. The 2026-09-09 production run took a live seat
 * with nothing but a gameCode and a studentId; a fallback would leave that door open.
 *
 * Unlike the other three endpoints this one is student-facing, so it carries
 * contract_version (pass A excluded it only because it was not then a matcher→guest
 * surface) but no bearer secret.
 */
export const resumeClassPlayer = onRequest(
  { secrets: [CLASSROOM_PROVISION_SECRET], cors: true, maxInstances: 100 },
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "This endpoint accepts POST only.");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vErr = contractVersionError(body);
    if (vErr) {
      sendError(res, 400, vErr.code, vErr.message);
      return;
    }
    const parsed = validateGameCode(body.gameCode);
    if (!parsed.ok) {
      sendError(res, 400, "INVALID_GAME_CODE", parsed.message);
      return;
    }
    const gameCode = parsed.code;
    const studentId = String(body.studentId ?? "").trim();
    if (!studentId) {
      sendError(res, 400, "STUDENT_ID_REQUIRED", "studentId is required.");
      return;
    }

    // D2: prove the claim BEFORE touching any seat state. Verification is pure — no reads,
    // no writes — so an unsigned or expired guess never reaches Firestore and can never
    // stamp lastHeartbeatAt (which is what `participated` grades on).
    const verdict = verifySeatToken(body.seatToken, gameCode, studentId, CLASSROOM_PROVISION_SECRET.value());
    if (!verdict.ok) {
      const status = verdict.code === "SEAT_TOKEN_REQUIRED" ? 400 : 401;
      sendError(res, status, verdict.code, verdict.message);
      return;
    }

    try {
      const gameRef = db().collection("games").doc(gameCode);
      const lockSnap = await gameRef.collection("classroomPlayers").doc(studentId).get();
      if (!lockSnap.exists) {
        sendError(res, 404, "SEAT_NOT_FOUND", "No seat found for this student in this session.");
        return;
      }
      const playerId = (lockSnap.data() as { playerId?: string }).playerId;
      if (!playerId) {
        sendError(res, 409, "SEAT_LOCK_INVALID", "Seat lock is invalid.");
        return;
      }

      const playerRef = gameRef.collection("players").doc(playerId);
      const playerSnap = await playerRef.get();
      if (!playerSnap.exists) {
        sendError(res, 404, "SEAT_PLAYER_MISSING", "Seat player record is missing.");
        return;
      }
      const player = playerSnap.data() as Record<string, unknown>;

      const token = newSessionToken();
      await playerRef.update({
        sessionTokenHash: hashToken(token),
        lastHeartbeatAt: FieldValue.serverTimestamp(),
      });

      sendOk(res, {
        playerId,
        role: player.role ?? null,
        teamId: player.teamId ?? null,
        teamName: player.teamName ?? null,
        name: player.name ?? null,
        sessionToken: token,
      });
    } catch (err) {
      logger.error("resumeClassPlayer failed", { gameCode, err: String(err) });
      sendError(res, 500, "INTERNAL", "Claiming the seat failed.");
    }
  }
);

/**
 * getClassResults — server-to-server (same secret as provisioning). Returns per-team and
 * per-player COSTS for a classroom session, so the matcher can pool costs across all its teams
 * (which live in separate games) and compute a cross-team z-score + write the gradebook. This
 * is read-only and does NOT end the session or push anything itself — grading is the matcher's
 * job now (the auto-push on end is disabled; see classroomResults.ts).
 */
export const getClassResults = onRequest(
  { secrets: [CLASSROOM_PROVISION_SECRET], cors: true, maxInstances: 20 },
  async (req, res) => {
    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "This endpoint accepts POST only."); return;
    }
    if (!bearerMatches(req.headers.authorization, CLASSROOM_PROVISION_SECRET.value())) {
      sendError(res, 401, "UNAUTHORIZED", "A valid provisioning secret is required."); return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vErr = contractVersionError(body);
    if (vErr) { sendError(res, 400, vErr.code, vErr.message); return; }
    const parsed = validateGameCode(body.gameCode);
    if (!parsed.ok) { sendError(res, 400, "INVALID_GAME_CODE", parsed.message); return; }
    const gameCode = parsed.code;
    try {
    const gameRef = db().collection("games").doc(gameCode);
    const [gameSnap, teamsSnap, playersSnap] = await Promise.all([
      gameRef.get(),
      gameRef.collection("teams").get(),
      gameRef.collection("players").get(),
    ]);
    if (!gameSnap.exists) { sendError(res, 404, "NOT_FOUND", "No session with that game code."); return; }

    // Each team's total cost + role → individual cost (sum of that stage's weekly cost).
    const teams = teamsSnap.docs.map((d) => {
      const t = d.data() as Record<string, unknown>;
      const stages = (t.stages ?? {}) as Record<string, { history?: Array<{ cost?: number }> }>;
      const costByRole: Record<string, number> = {};
      for (const role of ROLES) {
        costByRole[role] = (stages[role]?.history ?? []).reduce((s, h) => s + Number(h.cost ?? 0), 0);
      }
      return {
        teamId: d.id,
        teamName: typeof t.name === "string" ? t.name : d.id,
        teamCost: Number(t.totalCost ?? 0),
        costByRole,
      };
    });
    const teamById = new Map(teams.map((t) => [t.teamId, t]));

    // One row per HUMAN player, with the classroom studentId, role, and their individual cost.
    const players = playersSnap.docs
      .map((d) => d.data() as Record<string, unknown>)
      .filter((d) => typeof d.classroomStudentId === "string" && d.isRobot !== true)
      .map((d) => {
        const team = typeof d.teamId === "string" ? teamById.get(d.teamId) : undefined;
        const role = typeof d.role === "string" ? d.role : null;
        return {
          studentId: d.classroomStudentId as string,
          role,
          teamId: (d.teamId as string) ?? null,
          teamName: team?.teamName ?? null,
          teamCost: team?.teamCost ?? null,
          individualCost: role && team ? (team.costByRole[role] ?? null) : null,
          participated: d.lastHeartbeatAt != null,
        };
      });

    sendOk(res, { ok: true, gameCode, teams, players });
    } catch (err) {
      logger.error("getClassResults failed", { gameCode, err: String(err) });
      sendError(res, 500, "INTERNAL", "Reading session results failed.");
    }
  }
);
