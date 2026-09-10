import { HttpsCallableResult, httpsCallable } from "firebase/functions";
import { signInAnonymously } from "firebase/auth";
import { auth, functions } from "./firebase";
import { GameConfig } from "./logic/gameModel";

let pendingAnon: Promise<unknown> | null = null;
async function ensurePlayerAuth() {
  if (auth.currentUser) {
    return;
  }
  if (!pendingAnon) {
    pendingAnon = signInAnonymously(auth).finally(() => {
      pendingAnon = null;
    });
  }
  await pendingAnon;
}

export interface JoinOrResumeResponse {
  mode: "created" | "reconnected";
  playerId: string;
  role: string;
  sessionToken: string;
}

const submitInstructorApplicationFn = httpsCallable<
  { name: string; institution: string; country: string },
  { status: string; role: string }
>(functions, "submitInstructorApplication");

const ensureAdminProfileFn = httpsCallable<
  Record<string, never>,
  { created: boolean }
>(functions, "ensureAdminProfile");

const syncEmailVerifiedFn = httpsCallable<
  Record<string, never>,
  { emailVerified: boolean }
>(functions, "syncEmailVerified");

const adminReviewInstructorFn = httpsCallable<
  { instructorUid: string; decision: "approve" | "reject" },
  { status: string }
>(functions, "adminReviewInstructor");

const adminRevokeInstructorFn = httpsCallable<
  { instructorUid: string },
  { status: string }
>(functions, "adminRevokeInstructor");

const adminDeleteInstructorFn = httpsCallable<
  { instructorUid: string },
  { deleted: boolean }
>(functions, "adminDeleteInstructor");

const createSessionFn = httpsCallable<
  { notes: string; config: GameConfig },
  { gameCode: string }
>(functions, "createSession");

const deleteSessionFn = httpsCallable<
  { gameCode: string },
  { deleted: boolean }
>(functions, "deleteSession");

const joinOrResumePlayerFn = httpsCallable<
  { gameCode: string; name: string },
  JoinOrResumeResponse
>(functions, "joinOrResumePlayer");

export interface ClassSeatResponse {
  playerId: string;
  role: string | null;
  teamId: string | null;
  teamName: string | null;
  // Present when the matcher supplied a display name (a tenant that declares names — the Beer
  // Game does). Optional because a tenant that declined names gets no name field.
  name?: string | null;
  sessionToken: string;
}

// Classroom deep-link (D2/D3): PLAIN HTTP, not a callable. The student presents the
// signed seat token the matcher minted; there is no Firebase auth and no shared secret in
// the browser. `functions` is still imported for every OTHER callable in this file — only
// this one endpoint left the callable protocol, because only this one is part of the
// stack-agnostic guest contract a third party has to reimplement.
const RESUME_URL =
  (import.meta.env.VITE_RESUME_CLASS_PLAYER_URL as string | undefined) ??
  "https://us-central1-beergame-mygames-live.cloudfunctions.net/resumeClassPlayer";

const submitPlayerOrderFn = httpsCallable<
  { gameCode: string; playerId: string; sessionToken: string; order: number },
  { ok: boolean }
>(functions, "submitPlayerOrder");

const heartbeatPlayerFn = httpsCallable<
  { gameCode: string; playerId: string; sessionToken: string },
  { ok: boolean; serverTime: number }
>(functions, "heartbeatPlayer");

function unwrap<T>(result: HttpsCallableResult<T>): T {
  return result.data;
}

export async function submitInstructorApplication(input: {
  name: string;
  institution: string;
  country: string;
}) {
  return unwrap(await submitInstructorApplicationFn(input));
}

export async function ensureAdminProfile() {
  return unwrap(await ensureAdminProfileFn({}));
}

export async function syncEmailVerified() {
  return unwrap(await syncEmailVerifiedFn({}));
}

export async function adminReviewInstructor(input: {
  instructorUid: string;
  decision: "approve" | "reject";
}) {
  return unwrap(await adminReviewInstructorFn(input));
}

export async function adminRevokeInstructor(input: { instructorUid: string }) {
  return unwrap(await adminRevokeInstructorFn(input));
}

export async function adminDeleteInstructor(input: { instructorUid: string }) {
  return unwrap(await adminDeleteInstructorFn(input));
}

export async function createSession(input: { notes: string; config: GameConfig }) {
  return unwrap(await createSessionFn(input));
}

export async function deleteSession(input: { gameCode: string }) {
  return unwrap(await deleteSessionFn(input));
}

export async function joinOrResumePlayer(input: {
  gameCode: string;
  name: string;
}) {
  await ensurePlayerAuth();
  return unwrap(await joinOrResumePlayerFn(input));
}

/**
 * Claim a pre-assigned seat with a signed seat token (D2/D3).
 * ⚠ No ensurePlayerAuth() — the anonymous Firebase login this used to require identified
 * nobody and existed only so an onCall had some auth. The token is the credential now.
 * Errors arrive as pass A's structured bodies: { contract_version, error: { code, message } }.
 */
export async function resumeClassPlayer(input: {
  gameCode: string;
  studentId: string;
  seatToken: string;
}): Promise<ClassSeatResponse> {
  const res = await fetch(RESUME_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contract_version: 1, ...input }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body?.error?.code ?? `HTTP_${res.status}`;
    const message = body?.error?.message ?? `Seat claim failed (HTTP ${res.status}).`;
    throw new Error(`${code}: ${message}`);
  }
  return body as ClassSeatResponse;
}

export async function submitPlayerOrder(input: {
  gameCode: string;
  playerId: string;
  sessionToken: string;
  order: number;
}) {
  await ensurePlayerAuth();
  return unwrap(await submitPlayerOrderFn(input));
}

export async function heartbeatPlayer(input: {
  gameCode: string;
  playerId: string;
  sessionToken: string;
}) {
  await ensurePlayerAuth();
  return unwrap(await heartbeatPlayerFn(input));
}
