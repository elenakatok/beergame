// ═══════════════════════════════════════════════════════════════════════════════
// BEER GAME — BROWSER robot driver (matcher → Beer Game, plays through the real UI).
//
// Unlike bot/robot-driver.mjs (headless, callable-based, self-provisions a beergame
// session), this one is a BROWSER bot in the mould of the other games' robot-driver.mjs:
// headed, tiled Chromium windows an instructor can watch, driving the REAL UI — no game
// change, no callables. It plays the WHOLE classroom flow:
//
//   1. open the student's MATCHER launch URL (from the launcher, ?token=…&_session=tab);
//   2. drive the matcher front-of-house (online: click "Continue" on the group reveal),
//      then WAIT for the matcher to hand the group off to the Beer Game (the page
//      redirects itself to ?class=<gameCode>&sid=<pid> when the instructor presses Start);
//   3. on the Beer Game play screen, each week: read the incoming order, type it in the
//      order box, click Submit — a pure pass-through order (the textbook no-amplification
//      baseline) — until the game ends.
//
// PREREQ: the instructor has, in the matcher dashboard, put the instance in ONLINE mode,
// grouped the roster, and (when ready) pressed "Start the game". The bots can be opened any
// time after grouping; each waits at the hand-off screen and enters the Beer Game the moment
// its group is started. The launcher spawns this with --instance.
//
// Usage: node browser-robot-driver.mjs --instance <matcherInstanceId> [--seats 4]
//        [--pace watch|fast] [--launcher http://localhost:5180] [--screen 1920x1080]
// Prereq: Playwright (installed at the repo root for the other games' bots).
// ═══════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k.startsWith('--')) a[k.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]
  }
  return a
}
const args = parseArgs(process.argv.slice(2))
const INSTANCE = args.instance
const SEATS = Math.max(1, Math.min(16, Number(args.seats) || 4))
const PACE = String(args.pace || 'watch')
const LAUNCHER = String(args.launcher || 'http://localhost:5180').replace(/\/$/, '')
const [SCREEN_W, SCREEN_H] = String(args.screen || '1920x1080').split('x').map(Number)
// Top-left of the monitor to tile onto (Chrome's window coords span all displays). Set
// --origin "x,y" (or ROBOT_ORIGIN via the launcher) to your large monitor's top-left; e.g. a
// monitor to the LEFT of the primary is negative x, to the RIGHT is x ≥ primary width.
const [ORIGIN_X, ORIGIN_Y] = String(args.origin || '0,0').split(',').map(Number)

if (!INSTANCE || INSTANCE === true) {
  console.error('ERROR: --instance <matcherInstanceId> is required.')
  process.exit(1)
}

// "watch" paces the bots at human speed so a class can follow along; "fast" is a smoke run.
const THINK = PACE === 'watch' ? { min: 2500, max: 6000 } : { min: 400, max: 900 }
const POLL_MS = 1500
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const think = () => sleep(THINK.min + Math.random() * (THINK.max - THINK.min))

// ── window tiling ──────────────────────────────────────────────────────────────
function tile(index, total) {
  const cols = Math.ceil(Math.sqrt(total))
  const w = Math.floor(SCREEN_W / cols)
  const h = Math.floor(SCREEN_H / Math.ceil(total / cols))
  return { x: ORIGIN_X + (index % cols) * w, y: ORIGIN_Y + Math.floor(index / cols) * h, width: w, height: h }
}

// ⚠ ANTI-THROTTLING FLAGS — load-bearing. With many tiled windows most are in the
// background, and Chrome THROTTLES background timers. The Beer Game gates its Submit button
// on animation timers ("Please wait for animations…"), so a throttled background window
// never enables Submit and its seat stalls (the "stuck on week 2, 0/4 submitted" symptom).
// These keep every window's timers running at full speed so the bots can play unfocused.
const NO_THROTTLE = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

// ── the student's raw matcher launch URL (login screen; we drive from there) ────
async function studentUrlFor(seatIndex) {
  const res = await fetch(`${LAUNCHER}/api/student-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // No mode:'ready' → the launcher returns the raw ?token= URL (no server-side drive);
    // we drive the matcher UI ourselves. `game_instance_id` is the required key.
    body: JSON.stringify({ game_instance_id: INSTANCE, index: seatIndex }),
  })
  if (!res.ok) throw new Error(`launcher /api/student-url failed: ${res.status} ${await res.text()}`)
  return (await res.json()).url
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1 — drive the matcher, wait for the hand-off into the Beer Game.
//
// Online mode lands the student on the group reveal ("Your group" + Continue), then the
// hand-off screen ("Your group is ready … waiting for the game to start"), which redirects
// itself to the Beer Game when the instructor presses Start. We just click Continue when it
// shows and wait for the Beer Game play screen to appear (the order input).
// ═══════════════════════════════════════════════════════════════════════════════
async function driveMatcherUntilHandoff(page, label, timeoutMs = 15 * 60 * 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // Beer Game play screen reached? (its order input is the unambiguous marker.)
    if (await page.locator('input.pv-order-input').count() > 0) return true
    // Group reveal — continue past it.
    const cont = page.locator('[data-testid="reveal-continue"]')
    if (await cont.count() > 0 && await cont.isVisible().catch(() => false)) {
      await cont.click().catch(() => {})
      console.log(`[${label}] matcher: continued past the group reveal`)
      await sleep(POLL_MS)
      continue
    }
    await sleep(POLL_MS)
  }
  return false
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2 — play the Beer Game through the UI.
//
//   READ  the incoming order from the "Incoming Orders / Demand" card (first .pv-card).
//   ACT   type it into input.pv-order-input and click button.pv-order-btn ("Submit order").
//
// Strategy: order = incoming order (pass-through). If the incoming value can't be read, fall
// back to a steady 4 — a valid order that keeps the game moving rather than stalling the seat.
// ═══════════════════════════════════════════════════════════════════════════════
const DEFAULT_ORDER = 4

async function readIncomingOrder(page) {
  // The first .pv-card is "Incoming Orders / Demand"; its number is the incoming order.
  const txt = await page.locator('.pv-card').first().innerText().catch(() => '')
  const nums = txt.match(/\d+/g)
  return nums && nums.length ? Number(nums[nums.length - 1]) : null
}

/** The current week, read from the "WEEK N" heading — the per-week guard so we order once. */
async function readWeek(page) {
  const txt = await page.getByText(/week\s+\d+/i).first().innerText().catch(() => '')
  const m = txt.match(/(\d+)/)
  return m ? Number(m[1]) : null
}

async function isGameOver(page) {
  return (await page.getByText(/game over/i).count().catch(() => 0)) > 0
}

/** True once the submit button leaves "Submit order" (i.e. the order was accepted). */
async function submitLanded(btn) {
  const t = (await btn.innerText().catch(() => '')) || ''
  return !/submit order/i.test(t)
}

async function playBeerGame(page, label) {
  let lastWeek = 0, weeksPlayed = 0
  const start = Date.now()
  const MAX_MS = 60 * 60 * 1000
  while (Date.now() - start < MAX_MS) {
    if (await isGameOver(page)) { console.log(`[${label}] Beer Game over — ${weeksPlayed} week(s) played`); return }

    const btn = page.locator('button.pv-order-btn').first()
    if (await btn.count() === 0) { await sleep(POLL_MS); continue }
    const btnText = (await btn.innerText().catch(() => '')) || ''
    const ready = /submit order/i.test(btnText) && !(await btn.isDisabled().catch(() => true))
    const week = await readWeek(page)

    // Order once per NEW week, only when the button actually offers it (animations done).
    if (ready && week != null && week > lastWeek) {
      await think()
      const incoming = await readIncomingOrder(page)
      const order = incoming != null && Number.isFinite(incoming) ? incoming : DEFAULT_ORDER
      await page.locator('input.pv-order-input').first().fill(String(order)).catch(() => {})
      await btn.click().catch(() => {})
      // Confirm the order landed before advancing the week guard — else retry next loop.
      const t0 = Date.now()
      let landed = false
      while (Date.now() - t0 < 6000) { await sleep(500); if (await submitLanded(btn)) { landed = true; break } }
      if (landed) { lastWeek = week; weeksPlayed++; console.log(`[${label}] week ${week}: ordered ${order} (incoming ${incoming ?? '?'})`) }
      else console.log(`[${label}] week ${week}: submit did not land — retrying`)
    } else {
      await sleep(POLL_MS)
    }
  }
  console.warn(`[${label}] ⚠ stopped after ${weeksPlayed} week(s) — game did not end within the cap`)
}

async function runSeat(page, label) {
  const handed = await driveMatcherUntilHandoff(page, label)
  if (!handed) { console.error(`[${label}] ✗ never reached the Beer Game (was the group started?)`); return }
  console.log(`[${label}] entered the Beer Game`)
  await playBeerGame(page, label)
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Beer Game BROWSER robots: ${SEATS} seat(s) on matcher instance ${INSTANCE} (pace=${PACE})`)
  const browsers = []
  const runs = []
  for (let i = 0; i < SEATS; i++) {
    const box = tile(i, SEATS)
    // ⚠ channel:'chrome' uses the system Google Chrome, NOT Playwright's bundled Chromium.
    // The Beer Game's Playwright (1.59) wants a Chromium build that isn't in the shared
    // ms-playwright cache (the other games run 1.62 → chromium-1234, which IS installed), so
    // the bundled path 404s with "Executable doesn't exist". Using the installed Chrome
    // sidesteps the version mismatch and needs no `playwright install`.
    const browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: [`--window-position=${box.x},${box.y}`, `--window-size=${box.width},${box.height}`, ...NO_THROTTLE],
    })
    browsers.push(browser)
    const page = await browser.newPage({ viewport: { width: box.width, height: box.height - 90 } })
    const url = await studentUrlFor(i)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    runs.push(runSeat(page, `seat ${i}`).catch((e) => console.error(`[seat ${i}]`, e.message)))
  }
  await Promise.all(runs)
  console.log('All seats done. Windows left open — close them when you are finished watching.')
  void browsers
}

main().catch((e) => { console.error(e); process.exit(1) })
