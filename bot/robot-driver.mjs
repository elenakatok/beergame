#!/usr/bin/env node
//
// Beer Game bot driver — "bot students" that play automatically.
//
// STRATEGY (Elena): each bot orders exactly the amount of the incoming order it
// sees this week (order == team.stages[<role>].incomingOrder). A pure pass-through
// order is the textbook "no amplification" policy — a useful classroom baseline to
// contrast against human play (which amplifies) and against "Beer GPT" (base demand
// + jitter, the game's own empty-seat filler).
//
// Unlike the negotiation/single-player bots (which drive the shared game-server
// token flow and click through a browser), the Beer Game is a guest with its own
// bridge, so this driver is callable-based and headless:
//   • resume each seat via resumeClassPlayer({gameCode, studentId})   (deep-link path)
//   • each week, read team.stages[role].incomingOrder from Firestore
//   • submitPlayerOrder({gameCode, playerId, sessionToken, order=incomingOrder})
//   • the server auto-advances once every human seat has ordered; stop at ended.
//
// Two modes:
//   --gamecode <c> --sids a,b,c,d      play the given seats of an existing session
//                                       (how the launcher invokes it after it provisions)
//   --provision [--students N] [--nweeks W] [--secret <s>|env CLASSROOM_PROVISION_SECRET]
//                                       provision a fresh session and play all seats
//                                       (self-contained; used for local testing)
//
// Targets the DEPLOYED game by default (beergame-mygames-live). Override the host
// pieces with --project / --apikey / --fnbase if pointing at another deployment.

const args = parseArgs(process.argv.slice(2));
const PROJECT = args.project || "beergame-mygames-live";
const API_KEY = args.apikey || "AIzaSyBjZBWU78dlscQ9cSnr46OM788SgHhfPaM"; // public web key
const FN_BASE = args.fnbase || `https://us-central1-${PROJECT}.cloudfunctions.net`;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const IDP = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`;
const POLL_MS = args.pace === "fast" ? 500 : 1200;
const ROLES = ["retailer", "wholesaler", "distributor", "factory"];

const log = (...a) => console.log(`[beergame-bot]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

async function anonToken() {
  const r = await fetch(IDP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error(`anon sign-in failed: ${JSON.stringify(j).slice(0, 200)}`);
  return j.idToken;
}

async function callable(fn, data, idToken) {
  const r = await fetch(`${FN_BASE}/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${fn}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// Read a team doc via Firestore REST (public-web read, allowed by rules for players).
async function readTeam(gameCode, teamId, idToken) {
  const r = await fetch(`${FS_BASE}/games/${gameCode}/teams/${teamId}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!r.ok) return null;
  const doc = await r.json();
  const f = doc.fields || {};
  const stages = f.stages?.mapValue?.fields || {};
  const roleInfo = {};
  for (const role of ROLES) {
    const s = stages[role]?.mapValue?.fields || {};
    roleInfo[role] = {
      incomingOrder: numField(s.incomingOrder),
      isRobot: s.isRobot?.booleanValue === true,
    };
  }
  const submitted = f.ordersSubmitted?.mapValue?.fields || {};
  const submittedRoles = new Set(
    Object.entries(submitted).filter(([, v]) => v.booleanValue === true).map(([k]) => k)
  );
  return { currentWeek: numField(f.currentWeek), roleInfo, submittedRoles };
}

async function readGame(gameCode, idToken) {
  const r = await fetch(`${FS_BASE}/games/${gameCode}`, { headers: { Authorization: `Bearer ${idToken}` } });
  const doc = await r.json();
  const f = doc.fields || {};
  const cfg = f.config?.mapValue?.fields || {};
  return { status: f.status?.stringValue ?? null, nWeeks: numField(cfg.nWeeks) || 40 };
}

function numField(v) {
  if (!v) return 0;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  return 0;
}

async function provision(secret, students, nWeeks) {
  const members = Array.from({ length: students }, (_, i) => ({
    studentId: `bot-${i + 1}`,
    displayName: `Bot ${i + 1}`,
  }));
  const body = { instanceId: `botrun-${students}`, groups: [{ groupId: "Bot Team", members }] };
  if (nWeeks) body.config = { nWeeks };
  const r = await fetch(`${FN_BASE}/provisionClassSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`provision failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json(); // { gameCode, seats:[{studentId, role, teamId, playerId}] }
}

// Play a single seat to completion: order == incoming order each week.
async function playSeat(gameCode, studentId) {
  const idToken = await anonToken();
  const seat = await callable("resumeClassPlayer", { gameCode, studentId }, idToken);
  const { playerId, role, teamId, sessionToken } = seat;
  log(`seat ${studentId} → ${role} (team ${teamId})`);
  const { nWeeks } = await readGame(gameCode, idToken);

  let lastSubmittedWeek = 0;
  for (let guard = 0; guard < 10000; guard++) {
    const game = await readGame(gameCode, idToken);
    const team = await readTeam(gameCode, teamId, idToken);
    if (!team) { await sleep(POLL_MS); continue; }
    if (game.status === "ended" || team.currentWeek > nWeeks) {
      log(`seat ${studentId} (${role}) done at week ${team.currentWeek}`);
      return;
    }
    const week = team.currentWeek;
    const alreadyOrdered = team.submittedRoles.has(role) || week === lastSubmittedWeek;
    if (!alreadyOrdered) {
      const order = team.roleInfo[role].incomingOrder; // STRATEGY: mirror incoming order
      await callable("submitPlayerOrder", { gameCode, playerId, sessionToken, order }, idToken);
      lastSubmittedWeek = week;
      log(`seat ${studentId} (${role}) week ${week}: ordered ${order} (= incoming)`);
    }
    await sleep(POLL_MS);
  }
}

(async () => {
  let gameCode = args.gamecode;
  let sids;

  if (args.provision) {
    const secret = args.secret || process.env.CLASSROOM_PROVISION_SECRET;
    if (!secret) throw new Error("--provision needs --secret <s> or env CLASSROOM_PROVISION_SECRET");
    const students = Number(args.students || 4);
    const nWeeks = args.nweeks ? Number(args.nweeks) : undefined;
    const res = await provision(secret, students, nWeeks);
    gameCode = res.gameCode;
    sids = res.seats.map((s) => s.studentId);
    log(`provisioned ${gameCode} with seats: ${sids.join(", ")}`);
  } else {
    if (!gameCode) throw new Error("need --gamecode <c> (with --sids) or --provision");
    sids = String(args.sids || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!sids.length) throw new Error("need --sids a,b,c,d");
  }

  log(`playing ${sids.length} seats of ${gameCode} (order = incoming order)`);
  await Promise.all(sids.map((sid) => playSeat(gameCode, sid)));
  log(`all seats finished for ${gameCode}`);
  process.exit(0);
})().catch((e) => { console.error("[beergame-bot] ERROR", e.message || e); process.exit(1); });
