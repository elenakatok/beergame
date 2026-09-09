// functions/src/seatToken.ts — GUEST SIDE: verify a seat token minted by the matcher.
//
// Spec D2 — "The seat claim is proven by a signed token, not asserted by the client. The
// matcher mints an HMAC over the seat identity plus an expiry, using a secret shared with
// the guest; the guest verifies it before granting the seat. This replaces trusting
// studentId from a query parameter."
//
// ⚠ WHAT THIS REPLACES, OBSERVED NOT ASSUMED. Against production on 2026-09-09 the
// conformance harness took a provisioned seat using nothing but a gameCode and a studentId
// — both of which travel in a URL — from an anonymous identity with no relationship to the
// student. It also minted a NEW session token in the process, evicting the real holder, and
// stamped lastHeartbeatAt so a no-show would have graded as `completed`. That is the defect
// this file closes.
//
// ── FORMAT ────────────────────────────────────────────────────────────────────
//   wire:       "<exp>.<hex hmac-sha256>"          e.g. "1788999999.3f2a…"
//   signed over: "seat.v1|<gameCode>|<studentId>|<exp>"
//
// `seat.v1` is a TOKEN-FORMAT tag, NOT the contract version. The contract stays at
// contract_version 1 through this pass; the tag exists so the same shared secret can never
// be made to verify a differently-shaped payload later.
//
// ⚠ The matcher's mint (mygames-matcher functions/src/seatToken.ts) MUST canonicalise
// identically. They are separate repos, so this is duplicated deliberately rather than
// shared; if you change the canonical string, change both, and the conformance harness's
// mint too, or every hand-off 401s.

import * as crypto from "crypto";

/** Signed material. Order and separator are part of the contract. */
export function canonicalSeatPayload(gameCode: string, studentId: string, exp: number): string {
  return `seat.v1|${gameCode}|${studentId}|${exp}`;
}

export type SeatTokenFailure =
  | "SEAT_TOKEN_REQUIRED"
  | "SEAT_TOKEN_MALFORMED"
  | "SEAT_TOKEN_INVALID"
  | "SEAT_TOKEN_EXPIRED";

export type SeatTokenResult =
  | { ok: true; exp: number }
  | { ok: false; code: SeatTokenFailure; message: string };

/**
 * Verify a seat token against the seat it claims. Signature first, expiry second, so an
 * unsigned guess cannot learn anything from timing which expiry values are plausible.
 *
 * ⚠ Per D1 there is NO unsigned fallback. A missing token is a refusal, not a downgrade.
 */
export function verifySeatToken(
  token: unknown,
  gameCode: string,
  studentId: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SeatTokenResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, code: "SEAT_TOKEN_REQUIRED", message: "A signed seat token is required." };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, code: "SEAT_TOKEN_MALFORMED", message: "Seat token is malformed." };
  }
  const expPart = token.slice(0, dot);
  const macPart = token.slice(dot + 1);
  if (!/^\d{1,12}$/.test(expPart) || !/^[0-9a-f]{64}$/.test(macPart)) {
    return { ok: false, code: "SEAT_TOKEN_MALFORMED", message: "Seat token is malformed." };
  }
  const exp = Number(expPart);

  const expected = crypto
    .createHmac("sha256", secret)
    .update(canonicalSeatPayload(gameCode, studentId, exp))
    .digest("hex");

  // Constant-time, and length-guarded because timingSafeEqual throws on a length mismatch.
  const a = Buffer.from(macPart, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, code: "SEAT_TOKEN_INVALID", message: "Seat token signature does not match this seat." };
  }
  if (exp <= nowSeconds) {
    return { ok: false, code: "SEAT_TOKEN_EXPIRED", message: "Seat token has expired; reopen the link from the classroom." };
  }
  return { ok: true, exp };
}
