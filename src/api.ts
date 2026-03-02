import { HttpsCallableResult, httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import { GameConfig } from "./logic/gameModel";

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

const adminReviewInstructorFn = httpsCallable<
  { instructorUid: string; decision: "approve" | "reject" },
  { status: string }
>(functions, "adminReviewInstructor");

const adminRevokeInstructorFn = httpsCallable<
  { instructorUid: string },
  { status: string }
>(functions, "adminRevokeInstructor");

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

export async function adminReviewInstructor(input: {
  instructorUid: string;
  decision: "approve" | "reject";
}) {
  return unwrap(await adminReviewInstructorFn(input));
}

export async function adminRevokeInstructor(input: { instructorUid: string }) {
  return unwrap(await adminRevokeInstructorFn(input));
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
  return unwrap(await joinOrResumePlayerFn(input));
}

export async function submitPlayerOrder(input: {
  gameCode: string;
  playerId: string;
  sessionToken: string;
  order: number;
}) {
  return unwrap(await submitPlayerOrderFn(input));
}

export async function heartbeatPlayer(input: {
  gameCode: string;
  playerId: string;
  sessionToken: string;
}) {
  return unwrap(await heartbeatPlayerFn(input));
}
