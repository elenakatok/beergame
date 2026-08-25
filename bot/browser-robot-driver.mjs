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
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const __dirname = dirname(fileURLToPath(import.meta.url))

// ⚠ LOAD PLAYWRIGHT FROM A SIBLING GAME whose bundled Chromium is actually installed in the
// shared ms-playwright cache. Two reasons: (1) the Beer Game's own Playwright (1.59) wants a
// Chromium build that ISN'T installed; (2) system Chrome (channel:'chrome') renders the headed
// windows BLANK WHITE once they're backgrounded on macOS. The sibling games run 16 headed
// bundled-Chromium windows reliably, so borrow their Playwright and use its bundled browser.
function loadChromium() {
  for (const sib of ['infoshare', 'winemaster', 'grays2', 'crisis', 'saa']) {
    try {
      const pw = createRequire(resolve(__dirname, `../../${sib}/package.json`))('playwright')
      if (pw?.chromium) return { chromium: pw.chromium, channel: undefined, from: sib }
    } catch { /* try next sibling */ }
  }
  // Last resort: our own Playwright via system Chrome (may render white when backgrounded).
  return { chromium: createRequire(import.meta.url)('playwright').chromium, channel: 'chrome', from: 'system-chrome' }
}
const { chromium, channel: CHANNEL, from: PW_FROM } = loadChromium()

// ── monitor auto-detection (macOS) ───────────────────────────────────────────
// Find the LARGEST display and return it in CHROME window coords (origin = the primary
// display's TOP-left, Y increasing downward). NSScreen reports frames in Cocoa coords
// (primary BOTTOM-left, Y up), so the Y axis is flipped: chromeY = primaryH − (nsY + nsH).
// This puts the bot windows on the big monitor without anyone typing coordinates. Returns
// null off macOS or if detection fails — the caller then falls back to defaults/flags.
function detectLargestDisplay() {
  try {
    const jxa = 'ObjC.import("AppKit"); var s=$.NSScreen.screens; var o=[]; for(var i=0;i<s.count;i++){var f=s.objectAtIndex(i).frame; o.push([f.origin.x,f.origin.y,f.size.width,f.size.height])}; JSON.stringify(o)'
    const frames = JSON.parse(execSync(`osascript -l JavaScript -e '${jxa}'`, { encoding: 'utf8' }).trim())
    if (!Array.isArray(frames) || frames.length === 0) return null
    const primary = frames.find((f) => f[0] === 0 && f[1] === 0) || frames[0]
    const primaryH = primary[3]
    let best = frames[0]
    for (const f of frames) if (f[2] * f[3] > best[2] * best[3]) best = f
    return { x: Math.round(best[0]), y: Math.round(primaryH - (best[1] + best[3])), w: Math.round(best[2]), h: Math.round(best[3]) }
  } catch { return null }
}

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

// Placement: explicit --screen / --origin win; otherwise AUTO-DETECT the largest monitor and
// tile there; otherwise fall back to the primary at 1920x1080. So by default the windows land
// on the big monitor with nothing to configure.
const detected = (args.screen || args.origin) ? null : detectLargestDisplay()
const [SCREEN_W, SCREEN_H] = args.screen
  ? String(args.screen).split('x').map(Number)
  : detected ? [detected.w, detected.h] : [1920, 1080]
const [ORIGIN_X, ORIGIN_Y] = args.origin
  ? String(args.origin).split(',').map(Number)
  : detected ? [detected.x, detected.y] : [0, 0]
if (detected) console.log(`Tiling onto the largest monitor: ${SCREEN_W}x${SCREEN_H} at (${ORIGIN_X},${ORIGIN_Y})`)

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
// Aspect-aware grid: on a wide monitor prefer more COLUMNS so each window is a usable shape
// (a plain ceil(sqrt) makes a 4×4 grid on an ultrawide → very short windows the game can't
// render into). cols ≈ sqrt(total × screenAspect).
const COLS = Math.max(1, Math.min(SEATS, Math.round(Math.sqrt(SEATS * (SCREEN_W / SCREEN_H)))))
const ROWS = Math.ceil(SEATS / COLS)
function tile(index) {
  const w = Math.floor(SCREEN_W / COLS)
  const h = Math.floor(SCREEN_H / ROWS)
  return { x: ORIGIN_X + (index % COLS) * w, y: ORIGIN_Y + Math.floor(index / COLS) * h, width: w, height: h }
}

// ⚠ ANTI-THROTTLING / ANTI-OCCLUSION FLAGS — load-bearing, and the ORDER OF DISCOVERY
// matters: the Beer Game gates its Submit button on a requestAnimationFrame animation, and
// macOS Chrome PAUSES rAF for any window it considers OCCLUDED — which, with many windows,
// is every window except the frontmost. That's why a stalled seat "wakes up" the moment you
// click it and freezes again when you click away. `CalculateNativeWinOcclusion` is Chrome's
// occlusion detector; disabling that FEATURE (not just backgrounding-occluded-windows) is
// what actually keeps every window's rAF running so all seats play unfocused. The timer
// flags stay for setTimeout/setInterval; IntensiveWakeUpThrottling is the aggressive
// background-timer clamp.
const NO_THROTTLE = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
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

async function playBeerGame(page, label) {
  let submissions = 0
  const start = Date.now()
  const MAX_MS = 60 * 60 * 1000
  let lastIdleLog = 0
  while (Date.now() - start < MAX_MS) {
    if (await isGameOver(page)) { console.log(`[${label}] Beer Game over — ${submissions} order(s) submitted`); return }

    const btn = page.locator('button.pv-order-btn').first()
    if (await btn.count() === 0) { await sleep(POLL_MS); continue }
    const btnText = (await btn.innerText().catch(() => '')) || ''
    // ⚠ "Submit order" TEXT (canOrder) is the cue to act — do NOT gate on the button being
    // enabled: the Beer Game DISABLES it until a valid number is typed (hasValidOrder), so a
    // ready seat sits at "Submit order" DISABLED forever if we wait for enabled. Fill first
    // (that enables it), then click — Playwright's click waits for the button to be actionable.
    const wantsOrder = /submit order/i.test(btnText)
    const week = await readWeek(page)

    if (wantsOrder) {
      await think()
      const incoming = await readIncomingOrder(page)
      const order = incoming != null && Number.isFinite(incoming) ? incoming : DEFAULT_ORDER
      await page.locator('input.pv-order-input').first().fill(String(order)).catch(() => {})
      await btn.click({ timeout: 8000 }).catch(() => {}) // waits for the fill to enable the button
      submissions++
      console.log(`[${label}] week ${week ?? '?'}: ordered ${order} (incoming ${incoming ?? '?'})`)
      await sleep(1500) // let the click register before re-reading the button
    } else {
      // ── Diagnostic: WHY idle? The button text says:
      //   "Please wait for animations…"       → animation still running (occlusion/rAF)
      //   "Reconnect to submit"                → connection unhealthy (heartbeat timers)
      //   "Order submitted – waiting for team" → THIS seat is done; a teammate is behind
      if (Date.now() - lastIdleLog > 12000) {
        console.log(`[${label}] week ${week ?? '?'} idle — button: "${btnText.trim().replace(/\s+/g, ' ')}"`)
        lastIdleLog = Date.now()
      }
      await sleep(POLL_MS)
    }
  }
  console.warn(`[${label}] ⚠ stopped after ${submissions} order(s) — game did not end within the cap`)
}

async function runSeat(page, label) {
  const handed = await driveMatcherUntilHandoff(page, label)
  if (!handed) { console.error(`[${label}] ✗ never reached the Beer Game (was the group started?)`); return }
  console.log(`[${label}] entered the Beer Game`)
  await playBeerGame(page, label)
}

// ⚠ FIT THE WHOLE BEER GAME IN A SMALL TILED WINDOW. The play screen is ~1000×860 CSS px; a
// The tiled windows are small, so the play screen may be clipped when watching — but the bot
// interacts through Playwright, which scrolls elements into view, so clipping does not stop it
// from ordering. (An automatic content-fit was tried via CSS zoom / device-scale-factor and
// caused blank-white or broken layout in headed Chrome; dropped in favour of just playing.)
const box0 = tile(0)

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Beer Game BROWSER robots: ${SEATS} seat(s) on matcher instance ${INSTANCE} (pace=${PACE}); ` +
    `grid ${COLS}×${ROWS}, window ${box0.width}×${box0.height}, playwright=${PW_FROM}`)
  const browsers = []
  const runs = []
  for (let i = 0; i < SEATS; i++) {
    const box = tile(i)
    const browser = await chromium.launch({
      headless: false,
      ...(CHANNEL ? { channel: CHANNEL } : {}), // bundled Chromium unless we fell back to system Chrome
      args: [`--window-position=${box.x},${box.y}`, `--window-size=${box.width},${box.height}`, ...NO_THROTTLE],
    })
    browsers.push(browser)
    // Explicit viewport (matches the window). ⚠ NOT viewport:null — that rendered the headed
    // windows blank white. CSS zoom (playBeerGame) shrinks the content to fit this viewport.
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
