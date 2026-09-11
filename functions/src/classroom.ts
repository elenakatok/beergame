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
import { gradeClass } from "./classGrades";

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
  // ── D5 seat-count surface (pass C) ──
  | "SEAT_COUNT_REQUIRED"
  | "SEAT_COUNT_MISMATCH"
  | "GROUP_EMPTY"
  | "GROUP_OVERFULL"
  | "MEMBER_STUDENT_ID_REQUIRED"
  | "DUPLICATE_STUDENT_ID"
  // ── D2/D3 seat-claim surface ──
  | "STUDENT_ID_REQUIRED"
  | "SEAT_TOKEN_REQUIRED"
  | "SEAT_TOKEN_MALFORMED"
  | "SEAT_TOKEN_INVALID"
  | "SEAT_TOKEN_EXPIRED"
  | "SEAT_NOT_FOUND"
  | "SEAT_LOCK_INVALID"
  | "SEAT_PLAYER_MISSING"
  // ── guest-owned grading (Guest_Owned_Grading_Spec_Addendum_v1.md G1/G2) ──
  | "INSTANCE_ID_REQUIRED"
  | "GAME_CODES_REQUIRED"
  | "SESSION_NOT_IN_INSTANCE";

/**
 * Every error body: structured, coded, and carrying the version — including 500s.
 * `extra` adds machine-readable detail to the error object — e.g. expectedSeatCount, which
 * is how a caller learns this guest's seat count (D5) without a separate endpoint.
 */
function sendError(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  status: number,
  code: ContractErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  res.status(status).json({ contract_version: CONTRACT_VERSION, error: { code, message, ...extra } });
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

// displayName is OPTIONAL: the matcher sends it only for a tenant that declares it receives
// display names (matcher tenants.ts `receivesDisplayNames`). The Beer Game declares yes — its
// screens show players to each other by name. Absent → the player is shown by studentId.
interface ProvisionMember {
  studentId: string;
  displayName?: string;
}
interface ProvisionGroup {
  groupId?: string;
  members: ProvisionMember[];
}

/**
 * provisionClassSession — server-to-server. The matcher posts:
 *   { contract_version: 1, seatCount, instanceId?, config?: Partial<GameConfig>,
 *     groups: [{ groupId?, members: [{ studentId, displayName? }] }] }
 * We create one session per call and one team per group (roles shuffled onto the present
 * members, absent seats bot-filled), and return
 *   { contract_version, gameCode, seatCount, seats: [one per member], groups: [one per group] }.
 * Auth: Authorization: Bearer <CLASSROOM_PROVISION_SECRET>.
 *
 * ── PASS C (D4, D5) ────────────────────────────────────────────────────────────
 * NAMES — pass C's D4 removed displayName from the wire; that is REVERSED (2026-09-10). A
 *   member carries displayName when its tenant declares it receives names, and the player's
 *   name is that displayName. Without one the player is shown by studentId — correct for a
 *   tenant that declined names, not a degraded fallback. The seat claim returns `name` only
 *   when a displayName was supplied.
 * D5 — "The expected seat count is sent explicitly, and a mismatch is an error." seatCount
 *   must equal ROLES.length: missing → SEAT_COUNT_REQUIRED, different → SEAT_COUNT_MISMATCH,
 *   both carrying error.expectedSeatCount. Then, per group, BEFORE anything is written:
 *     OVER-FULL  → REJECTED (GROUP_OVERFULL). It used to be sliced to ROLES.length with no
 *                  error and no log, and the dropped student got a link that dead-ended.
 *     UNDER-FULL → ACCEPTED and REPORTED. This is the designed bot-fill path — the matcher
 *                  posts humans only and this guest fills the rest — so it cannot be an
 *                  error. What was wrong was the SILENCE: groups[].botSeats now says how many
 *                  seats went to bots, and the matcher checks it against its own count (D6).
 *     EMPTY group, member with no studentId, a studentId twice → REJECTED. The old code
 *                  skipped a nameless member silently; a duplicate collided on the seat lock.
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

    const body = (req.body ?? {}) as { config?: unknown; groups?: unknown; instanceId?: unknown; seatCount?: unknown };

    const vErr = contractVersionError(body as Record<string, unknown>);
    if (vErr) {
      sendError(res, 400, vErr.code, vErr.message);
      return;
    }

    // D5 — checked BEFORE groups[], so a caller probing with an empty groups[] learns this
    // guest's seat count and nothing is written (the conformance harness relies on the order).
    // A number only: "4" is not 4, and a caller sending a string has a bug worth naming.
    const seatCount = ROLES.length;
    if (body.seatCount === undefined || body.seatCount === null) {
      sendError(res, 400, "SEAT_COUNT_REQUIRED",
        `seatCount is required; this guest seats ${seatCount} per group.`,
        { expectedSeatCount: seatCount });
      return;
    }
    if (body.seatCount !== seatCount) {
      sendError(res, 400, "SEAT_COUNT_MISMATCH",
        `seatCount ${JSON.stringify(body.seatCount)} does not match this guest's ${seatCount} seats per group.`,
        { expectedSeatCount: seatCount });
      return;
    }

    const groups = Array.isArray(body.groups) ? (body.groups as ProvisionGroup[]) : null;
    if (!groups || groups.length === 0) {
      sendError(res, 400, "GROUPS_REQUIRED", "groups[] is required and must be non-empty.");
      return;
    }

    // D5 — validate the WHOLE request before a single write, so a bad second group can never
    // leave a half-built session behind.
    const seen = new Set<string>();
    const planned: Array<{ groupId: string; studentIds: string[]; displayNames: unknown[] }> = [];
    for (let gi = 0; gi < groups.length; gi += 1) {
      const group = (groups[gi] ?? {}) as ProvisionGroup;
      const groupId =
        typeof group.groupId === "string" && group.groupId.trim() ? group.groupId.trim() : `group-${gi + 1}`;
      const members: unknown[] = Array.isArray(group.members) ? group.members : [];
      if (members.length === 0) {
        sendError(res, 400, "GROUP_EMPTY", `groups[${gi}] (${groupId}) has no members.`,
          { groupIndex: gi, groupId });
        return;
      }
      if (members.length > seatCount) {
        sendError(res, 400, "GROUP_OVERFULL",
          `groups[${gi}] (${groupId}) has ${members.length} members for ${seatCount} seats.`,
          { groupIndex: gi, groupId, expectedSeatCount: seatCount });
        return;
      }
      const studentIds: string[] = [];
      const displayNames: unknown[] = [];
      for (let mi = 0; mi < members.length; mi += 1) {
        const raw = (members[mi] as { studentId?: unknown } | null)?.studentId;
        const studentId = typeof raw === "string" ? raw.trim() : "";
        if (!studentId) {
          sendError(res, 400, "MEMBER_STUDENT_ID_REQUIRED",
            `groups[${gi}].members[${mi}] has no studentId.`, { groupIndex: gi, memberIndex: mi });
          return;
        }
        if (seen.has(studentId)) {
          sendError(res, 400, "DUPLICATE_STUDENT_ID",
            `studentId ${studentId} appears more than once in this request.`,
            { groupIndex: gi, memberIndex: mi });
          return;
        }
        seen.add(studentId);
        studentIds.push(studentId);
        displayNames.push((members[mi] as { displayName?: unknown } | null)?.displayName);
      }
      planned.push({ groupId, studentIds, displayNames });
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
    // D5: how every group's seats were filled. The matcher checks humanSeats/botSeats against
    // its own count (D6); this is what makes a bot-filled seat visible across the boundary.
    const groupReports: Array<{
      groupId: string;
      teamId: string;
      humanSeats: number;
      botSeats: number;
      botRoles: Role[];
    }> = [];

    // Friendly, on-theme team names ("Hoppy Campers") instead of the raw matcher group
    // UUID. `usedTeamNames` keeps them distinct across the groups in this call. The real
    // matcher group id is preserved separately (see `groupId` on each seat below) — it is
    // NOT the display name, and grade attribution keys on classroomStudentId regardless.
    const usedTeamNames = new Set<string>();

    planned.forEach((plan, gi) => {
      const teamId = `team${gi + 1}`;
      const teamName = pickTeamName(gi, usedTeamNames);
      const team = createInitialTeamState(teamId, teamName);

      // Shuffle role order so seat assignment is fair across a class.
      const roleOrder = [...ROLES];
      for (let i = roleOrder.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1);
        [roleOrder[i], roleOrder[j]] = [roleOrder[j], roleOrder[i]];
      }

      // Every id here was validated above, and there are never more than seatCount of them,
      // so each member gets a role — nothing is skipped or dropped at this point.
      plan.studentIds.forEach((studentId, mi) => {
        const role = roleOrder[mi];
        // RESTORED from before pass C (9377a6d), line for line: the player's name is the
        // displayName the matcher sent, falling back to studentId when none was sent — which
        // is now the right behaviour for a tenant that declined names, not a defect covered up.
        const rawName = plan.displayNames[mi];
        const displayName = String(rawName ?? studentId).trim() || studentId;
        // Whether a name was actually SUPPLIED. Only this decides whether the seat claim
        // returns one, so a tenant that declined names can never be handed a name.
        const nameFromClassroom = rawName != null && String(rawName).trim() !== "";
        const playerRef = gameRef.collection("players").doc();
        batch.set(playerRef, {
          name: displayName,
          normalizedName: normalizeName(displayName),
          nameFromClassroom,
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
        seats.push({ studentId, role, teamId, playerId: playerRef.id, groupId: plan.groupId });
      });

      // Bot-fill every seat with no present student (product decision #8) — and SAY which.
      const botRoles: Role[] = [];
      for (const role of ROLES) {
        if (team.stages[role].playerId == null) {
          team.stages[role].playerId = null;
          team.stages[role].playerName = "Beer GPT";
          team.stages[role].isRobot = true;
          botRoles.push(role);
        }
      }
      groupReports.push({
        groupId: plan.groupId, teamId,
        humanSeats: plan.studentIds.length, botSeats: botRoles.length, botRoles,
      });

      batch.set(gameRef.collection("teams").doc(teamId), team);
    });

    await batch.commit();
    logger.info("provisionClassSession created", {
      gameCode: code, groups: planned.length, seats: seats.length,
      botSeats: groupReports.reduce((n, g) => n + g.botSeats, 0),
    });
    sendOk(res, { gameCode: code, seatCount, seats, groups: groupReports });
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

      // `name` RESTORED (pass C's D4 removed it; D4 is reversed). Returned only when the
      // matcher supplied a displayName for this student — i.e. for a tenant that declares it
      // receives names. A tenant that declined gets no name field at all. (A player doc
      // written before nameFromClassroom existed has no flag and returns its name, exactly as
      // the pre-pass-C guest did.)
      sendOk(res, {
        playerId,
        role: player.role ?? null,
        teamId: player.teamId ?? null,
        teamName: player.teamName ?? null,
        ...(player.nameFromClassroom === false ? {} : { name: player.name ?? null }),
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
    // D9 — "getClassResults gets the source !== 'classroom' guard that finalize already has."
    // Without it, any game code readable with the secret returned costs — including sessions
    // the classroom never provisioned.
    if ((gameSnap.data() as Record<string, unknown>).source !== "classroom") {
      sendError(res, 403, "NOT_A_CLASSROOM_SESSION", "That session was not provisioned by the classroom.");
      return;
    }

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

/**
 * getClassGrades — server-to-server (same secret). THE GUEST GRADES ITS OWN CLASS.
 *
 * Guest_Owned_Grading_Spec_Addendum_v1.md G2 — "A fifth endpoint, getClassGrades, keyed on the
 * instance, not the session. The matcher provisions one session per group, so a guest answering
 * per session sees one team and cannot normalize across a class."
 *
 * Request:  { contract_version: 1, instanceId, gameCodes: [ …the sessions the matcher recorded… ] }
 * Reply:    { contract_version: 1, ok: true, instanceId, grades: [ { studentId, value, label } ] }
 *   One row per student provisioned into the listed sessions. `value` is a finite number, or null
 *   for a student with no grade (never claimed a seat). The matcher pushes it AS GIVEN into the
 *   gradebook's normalized_score — the one score field the gradebook renders. (classGrades.ts)
 *
 * ⚠ ORPHAN SESSIONS (addendum §6 Q7, §7). provisionClassSession writes a session — carrying this
 * classroomInstanceId — BEFORE the matcher verifies the reply. When the matcher refuses the
 * hand-off (D6) it ends that session and re-provisions the same students into a new one. So a
 * query by instance alone returns orphan sessions and duplicate students. The matcher's group
 * docs are the only record of which hand-offs it ACCEPTED, so it LISTS them (gameCodes) and this
 * endpoint grades exactly those: every other session carrying the instance id is excluded. No
 * marker is needed on the session, so orphans written before this endpoint existed are excluded
 * too. A listed code that belongs to a different instance is refused, never silently graded.
 *
 * gameCodes' ORDER is the matcher's (group-id order). Team costs are pooled in that order so the
 * z is bit-for-bit the one the matcher computed before grading moved here.
 */
export const getClassGrades = onRequest(
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

    const instanceId = typeof body.instanceId === "string" ? body.instanceId.trim() : "";
    if (!instanceId) {
      sendError(res, 400, "INSTANCE_ID_REQUIRED", "instanceId is required: grades are keyed on the classroom instance.");
      return;
    }
    if (!Array.isArray(body.gameCodes) || body.gameCodes.length === 0) {
      sendError(res, 400, "GAME_CODES_REQUIRED",
        "gameCodes[] is required and must list the sessions the matcher recorded for this instance.");
      return;
    }
    const gameCodes: string[] = [];
    for (let i = 0; i < body.gameCodes.length; i += 1) {
      const parsed = validateGameCode(body.gameCodes[i]);
      if (!parsed.ok) { sendError(res, 400, "INVALID_GAME_CODE", `gameCodes[${i}]: ${parsed.message}`, { index: i }); return; }
      if (gameCodes.includes(parsed.code)) {
        sendError(res, 400, "INVALID_GAME_CODE", `gameCodes[${i}] ${parsed.code} is listed twice.`, { index: i });
        return;
      }
      gameCodes.push(parsed.code);
    }

    try {
      const games = db().collection("games");
      const inInstance = await games.where("classroomInstanceId", "==", instanceId).get();
      const byCode = new Map(inInstance.docs.map((d) => [d.id, d.data() as Record<string, unknown>]));
      for (const code of gameCodes) {
        const data = byCode.get(code);
        if (!data) {
          const snap = await games.doc(code).get();
          if (!snap.exists) {
            sendError(res, 404, "NOT_FOUND", `No session with game code ${code}.`, { gameCode: code });
          } else {
            sendError(res, 409, "SESSION_NOT_IN_INSTANCE",
              `Session ${code} does not belong to instance ${instanceId}.`, { gameCode: code });
          }
          return;
        }
        if (data.source !== "classroom") {
          sendError(res, 403, "NOT_A_CLASSROOM_SESSION", `Session ${code} was not provisioned by the classroom.`,
            { gameCode: code });
          return;
        }
      }

      // Exactly the listed sessions, in the listed order.
      const sessions = await Promise.all(gameCodes.map(async (gameCode) => {
        const ref = games.doc(gameCode);
        const [teamsSnap, playersSnap] = await Promise.all([ref.collection("teams").get(), ref.collection("players").get()]);
        return {
          gameCode,
          teams: teamsSnap.docs.map((d) => ({ teamId: d.id, data: d.data() as Record<string, unknown> })),
          players: playersSnap.docs.map((d) => d.data() as Record<string, unknown>),
        };
      }));
      const grades = gradeClass(sessions);
      logger.info("getClassGrades graded the instance", {
        instanceId, sessions: gameCodes.length, excludedSessions: inInstance.size - gameCodes.length, rows: grades.length,
      });
      sendOk(res, { ok: true, instanceId, grades });
    } catch (err) {
      logger.error("getClassGrades failed", { instanceId, err: String(err) });
      sendError(res, 500, "INTERNAL", "Reading the class's grades failed.");
    }
  }
);
