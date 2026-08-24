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
//   • resumeClassPlayer      (student-facing callable): the deep-linked student
//     exchanges their classroom studentId for their pre-assigned seat
//     (playerId / role / sessionToken), which drives the existing PlayerView.
//
// This file is additive and self-contained (no edits to Enno's index.ts beyond a
// re-export), to keep merges with upstream cheap.

import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
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

const CLASSROOM_PROVISION_SECRET = defineSecret("CLASSROOM_PROVISION_SECRET");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
// App Check is opt-in (see index.ts): enforced only when APPCHECK_ENFORCE=true.
const ENFORCE_APP_CHECK =
  process.env.FUNCTIONS_EMULATOR !== "true" && process.env.APPCHECK_ENFORCE === "true";

const db = () => admin.firestore();

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
function parseGameCode(raw: unknown): string {
  if (typeof raw !== "string") throw new HttpsError("invalid-argument", "gameCode is required.");
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z2-9]{4,8}$/.test(code)) throw new HttpsError("invalid-argument", "Invalid game code.");
  return code;
}
function requireAuthUid(request: { auth?: { uid?: string } | null }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication is required.");
  return uid;
}
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
      res.status(405).json({ error: "method-not-allowed" });
      return;
    }
    if (!bearerMatches(req.headers.authorization, CLASSROOM_PROVISION_SECRET.value())) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const body = (req.body ?? {}) as { config?: unknown; groups?: unknown; instanceId?: unknown };
    const groups = Array.isArray(body.groups) ? (body.groups as ProvisionGroup[]) : null;
    if (!groups || groups.length === 0) {
      res.status(400).json({ error: "groups[] is required" });
      return;
    }
    // The classroom's game_instances/<id> — used as game_instance_id when results
    // are pushed back to the gradebook. Falls back to the game code if absent.
    const classroomInstanceId =
      typeof body.instanceId === "string" && body.instanceId.trim() ? body.instanceId.trim() : null;

    const config = sanitizeConfig(body.config);
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
    res.json({ gameCode: code, seats });
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
      res.status(405).json({ error: "method-not-allowed" });
      return;
    }
    if (!bearerMatches(req.headers.authorization, CLASSROOM_PROVISION_SECRET.value())) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const gameCode = parseGameCode((req.body ?? {}).gameCode);
    const gameRef = db().collection("games").doc(gameCode);
    const snap = await gameRef.get();
    if (!snap.exists) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    const data = snap.data() as Record<string, unknown>;
    if (data.source !== "classroom") {
      res.status(403).json({ error: "not-a-classroom-session" });
      return;
    }
    if (data.status === "ended") {
      res.json({ ok: true, alreadyEnded: true });
      return;
    }
    await gameRef.update({ status: "ended", endedAt: FieldValue.serverTimestamp() });
    logger.info("finalizeClassSession ended session", { gameCode });
    res.json({ ok: true });
  }
);

/**
 * resumeClassPlayer — student-facing. The deep-linked student (anonymously
 * authenticated) exchanges { gameCode, studentId } for their pre-assigned seat.
 * Mints a fresh session token, exactly like joinOrResumePlayer's reconnect path,
 * so the existing PlayerView + submitPlayerOrder work unchanged.
 *
 * NOTE (production hardening, deferred): the studentId should be proven by a
 * signed classroom token rather than trusted from the client. For the guest
 * bridge slice it is looked up directly.
 */
export const resumeClassPlayer = onCall(
  { enforceAppCheck: ENFORCE_APP_CHECK, maxInstances: 100 },
  async (request) => {
    requireAuthUid(request);
    const gameCode = parseGameCode(request.data?.gameCode);
    const studentId = String(request.data?.studentId ?? "").trim();
    if (!studentId) throw new HttpsError("invalid-argument", "studentId is required.");

    const gameRef = db().collection("games").doc(gameCode);
    const lockSnap = await gameRef.collection("classroomPlayers").doc(studentId).get();
    if (!lockSnap.exists) {
      throw new HttpsError("not-found", "No seat found for this student in this session.");
    }
    const playerId = (lockSnap.data() as { playerId?: string }).playerId;
    if (!playerId) throw new HttpsError("failed-precondition", "Seat lock is invalid.");

    const playerRef = gameRef.collection("players").doc(playerId);
    const playerSnap = await playerRef.get();
    if (!playerSnap.exists) throw new HttpsError("not-found", "Seat player record is missing.");
    const player = playerSnap.data() as Record<string, unknown>;

    const token = newSessionToken();
    await playerRef.update({
      sessionTokenHash: hashToken(token),
      lastHeartbeatAt: FieldValue.serverTimestamp(),
    });

    return {
      playerId,
      role: player.role ?? null,
      teamId: player.teamId ?? null,
      teamName: player.teamName ?? null,
      name: player.name ?? null,
      sessionToken: token,
    };
  }
);
