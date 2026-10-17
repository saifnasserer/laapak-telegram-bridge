#!/usr/bin/env node
// Telegram -> OpenCode bridge.
// Long-polls the Telegram Bot API, maps each allowlisted chat to a persistent
// OpenCode session, and relays the agent's reply back.
//
// Auth for OpenCode is read from the existing server.env — never hardcoded.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, readdirSync } from "node:fs"
import { createServer } from "node:http"
import { recallMemory, formatRecall } from "./lib/memory-search.mjs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { dirname, join, resolve, basename } from "node:path"
import { fileURLToPath } from "node:url"

const pexecFile = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------- config ----------
// Usage: bridge.mjs [configPath]
// Config path defaults to ./bridge.json. Everything instance-specific --
// token, OpenCode endpoint, state file, pairing code -- lives in that file,
// so one script can serve many independent bots with no shared mutable state.
const CFG = process.argv[2] ? process.argv[2] : join(HERE, "bridge.json")

function loadConfig() {
  const cfg = JSON.parse(readFileSync(CFG, "utf8"))
  for (const k of ["tokenFile", "stateFile", "pairingCode"]) {
    if (!cfg[k]) throw new Error(`${CFG}: ${k} is required`)
  }
  for (const k of ["baseUrl", "serverEnv"]) {
    if (!cfg.opencode?.[k]) throw new Error(`${CFG}: opencode.${k} is required`)
  }
  // Defaults live here, not at the use site. A missing turnTimeoutMs would make
  // `Date.now() + undefined` NaN, and `Date.now() < NaN` is false -- so the turn
  // loop would exit on the first pass and every message would answer "timed
  // out" instantly. Silent, total, and caused by a typo in a JSON file.
  // Two hours. This used to be 10 minutes, and that was a real bug: a turn
  // measured at 712s was abandoned 113s before the agent finished, so the
  // answer existed and was never delivered. Dead turns are now caught by the
  // three precise detectors (hung tool at ~60s, wedge at 25s, stall at the
  // tool's own budget), so this blunt cap no longer needs to be the thing
  // standing between you and a lost answer. It is only a backstop.
  cfg.turnTimeoutMs ??= 7200000
  // Typing must stop well before the turn deadline so a dead turn reads as
  // "stopped typing", not as an indicator that blinks for ten minutes.
  cfg.typingMaxMs ??= Math.floor(cfg.turnTimeoutMs * 0.6)
  // Time-to-first-message before the turn is declared hung and the session is
  // thrown away. 25s was tight against the real cost of a turn: Lab's peak turn
  // context runs ~60k tokens on a throttled free endpoint, and on 2026-10-04 a
  // message arrived at 15:27:37 and was killed as "wedged" at 15:28:04 -- 27s,
  // just past the line, costing a full session rebuild plus a cold-start
  // bootstrap. 60000 gives a fat turn room to breathe while still catching a
  // genuinely dead session in a minute instead of 25s. Cost of being wrong in
  // this direction is bounded and visible: a slower detection, never a lost
  // answer.
  cfg.wedgeTimeoutMs ??= 60000
  cfg.stallTimeoutMs ??= 240000
  // The memory file is the bot's brain: the Core block inside it is injected into
  // every message, so continuity does not depend on the model, nor on the session
  // surviving. Defaults deliberately derive from workspaceDir, so a new bot gets a
  // brain just by existing rather than needing two config keys remembered.
  cfg.workspaceDir ??= null
  cfg.memoryFile ??= (cfg.workspaceDir ? join(cfg.workspaceDir, "MEMORY.md") : null)
  // Core is injected on every turn, so its cost is multiplied by every message.
  // 4 KB is about a thousand tokens -- invisible beside a real turn, but not
  // something to let grow without a ceiling. The loader truncates on a line
  // boundary and says so, rather than silently cutting mid-thought.
  cfg.memoryCoreMaxBytes ??= 4000
  // Memory v2 recall (2026-10-13): TF-IDF over memory/topics + recent daily
  // notes, appended after Core. Fail-open: search errors yield Core-only.
  cfg.memoryRecallEnable ??= true
  cfg.memoryRecallTopK ??= 3
  cfg.memoryRecallMaxChars ??= 1500
  // Observability (2026-10-13): JSONL logs + opt-in localhost health server.
  cfg.logsDir ??= join(HERE, "logs", cfg.name || "bridge")
  cfg.healthPort ??= 0 // 0 = disabled; set e.g. 4098 to enable
  // A tool with no declared timeout (read/write/glob/grep) should return in
  // milliseconds. One minute is already pathological by a wide margin, and
  // catching it here turns a 4-minute stall into a 1-minute self-recovery.
  cfg.toolNoTimeoutMs ??= 60000
  // Slack added to a tool's own declared timeout before calling it hung.
  cfg.toolGraceMs ??= 30000
  // No tool running at all: the model is generating. Nothing to compare
  // against, and the most false-positive-prone case, so it gets the most
  // patience.
  cfg.generationGraceMs ??= 600000
  // Long-task progress reporting. Without it a 20-minute job is 20 minutes of
  // silence, which is indistinguishable from the bot being dead -- the exact
  // ambiguity that made the 2026-09-30 outage hard to read. Stay quiet for
  // short turns, then report what the agent is actually doing.
  cfg.progressAfterMs ??= 150000
  cfg.progressEveryMs ??= 180000
  // Compaction threshold, in tokens of *peak per-turn prompt* -- not a session
  // lifetime total, see contextPeak() for why that distinction is the whole
  // ballgame. big-pickle's real ceiling is context 200000 / input 160000
  // (`/api/model`, verified 2026-10-04); the old default of 1500000 sat 9.4x
  // above the input limit, so the tripwire fired on every message forever and
  // could never correspond to a real risk. 120000 is ~2x Lab's observed ~60k
  // baseline and ~75% of the ceiling: fires on genuine bloat, stays quiet on
  // a normal turn. POST /api/session/{id}/compact cuts the prompt ~95% and
  // keeps every message readable, so this stays cheap insurance.
  cfg.compactAfterTokens ??= 120000
  return cfg
}
const CFG_ = loadConfig()

const TOKEN = readFileSync(CFG_.tokenFile, "utf8").trim()
const OC = CFG_.opencode
const STATE_FILE = CFG_.stateFile
const NAME = CFG_.name || "bridge"

// Incoming attachments land here, one folder per bot so the lab and hamada
// instances never mix each other's uploads. Telegram caps bot downloads at
// 20 MB, so the limit below mirrors the platform rather than a local policy.
const DL_DIR = CFG_.downloadsDir || join(HERE, "downloads", NAME)
const MAX_BYTES = 20 * 1024 * 1024

// ---------- durable conversation history ----------
// The problem this solves: when a session wedges and has to be replaced, the
// replacement starts empty and the agent suddenly forgets everything. That has
// now happened twice, and both times the context was still sitting in the
// database the whole time -- the 2026-09-30 dead session still had 166
// messages, 26 user turns and 36k characters of text, all readable. Nothing was
// ever lost; the bridge just threw it away by starting from nothing.
//
// So two layers, deliberately ordered:
//
//   1. recoverContext() reads the dead session over the API. This is the
//      authoritative source and the one that actually fires, because a wedged
//      session still serves its history -- that is exactly how it was
//      diagnosed. It works even when the agent is beyond saving.
//   2. A plain-text transcript on disk, appended after every turn. Slower to
//      fill, but it survives the session being deleted, the database being
//      wiped, or the OpenCode server being rebuilt. Last line of defence.
//
// This is deliberately not "ask the agent to read its memory files". That
// depends on the agent choosing to write them, and on it having a path to a
// database it cannot query. Neither survives the failure we are defending
// against. A transcript that the bridge writes itself needs no cooperation
// from the thing that just broke.
const HIST_DIR = CFG_.historyDir || join(HERE, "history", NAME)
const HIST_MAX_BYTES = CFG_.historyMaxBytes ?? 262144
const RECOVER_MSGS = CFG_.recoverMsgs ?? 24
const RECOVER_CHARS = CFG_.recoverChars ?? 12000

function histFile(chatId) {
  return join(HIST_DIR, `${String(chatId).replace(/[^\w-]/g, "") || "unknown"}.txt`)
}

// Append one turn to the on-disk transcript. Never throws into the caller: a
// full or read-only disk must not cost the user their reply.
function appendHistory(chatId, userText, replyText) {
  try {
    mkdirSync(HIST_DIR, { recursive: true })
    const f = histFile(chatId)
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19)
    appendFileSync(f, `\n--- ${stamp} ---\nUSER: ${userText}\nBOT: ${replyText}\n`)
    // Bound the file so a chat that runs for months cannot fill the disk.
    if (statSync(f).size > HIST_MAX_BYTES) {
      const keep = readFileSync(f, "utf8").slice(-Math.floor(HIST_MAX_BYTES / 2))
      truncateSync(f, 0)
      writeFileSync(f, "(earlier turns trimmed)\n" + keep)
    }
  } catch (e) {
    log(`history append failed: ${e.message}`)
  }
}

// Speech-to-text. All three pieces are optional: a missing binary must degrade
// to "file delivered, no transcript" rather than dropping the message.
const STT = {
  ffmpeg: CFG_.ffmpeg || "",
  cli: CFG_.whisperCli || "",
  model: CFG_.whisperModel || "",
  libPath: CFG_.whisperLibPath || "",
  lang: CFG_.whisperLanguage || "ar",
  maxMs: CFG_.whisperTimeoutMs || 120000,
}
const sttReady = () =>
  !!(STT.ffmpeg && STT.cli && STT.model) &&
  existsSync(STT.ffmpeg) && existsSync(STT.cli) && existsSync(STT.model)

// OpenCode credentials come from the same env file the web unit uses.
function ocAuth() {
  const envPath = CFG_.opencode.serverEnv
  const env = readFileSync(envPath, "utf8")
  const user = env.match(/OPENCODE_SERVER_USERNAME=(.*)/)?.[1]?.trim()
  const pass = env.match(/OPENCODE_SERVER_PASSWORD=(.*)/)?.[1]?.trim()
  if (!user || !pass) throw new Error(`could not read opencode auth from ${envPath}`)
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64")
}
const OC_AUTH = ocAuth()

// ---------- state ----------
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { sessions: {}, allow: [] }
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

// ---------- logging + observability (upgrade #7, 2026-10-13) ----------
// log() keeps its console behaviour; JSONL per-turn records go to
// bridge/logs/<bot>-YYYY-MM-DD.jsonl via logTurn(). Health server (opt-in
// via healthPort) serves localhost-only /healthz.
const BOOT_AT = Date.now()
const OBS = {
  lastTurnMs: 0,
  lastError: "",
  turnCount: 0,
  durations: [], // capped ring for p50/p95
  lateDrainPending: 0,
  lastTurn: null,
}
function obsPercentile(arr, q) {
  if (!arr.length) return 0
  const a = [...arr].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(q * a.length))]
}
const log = (...a) => console.log(new Date().toISOString(), `[${NAME}]`, ...a)
function logsDir() {
  try {
    const d = CFG_.logsDir || join(HERE, "logs", NAME)
    mkdirSync(d, { recursive: true })
    return d
  } catch {
    return null
  }
}
function logTurn(rec) {
  try {
    const d = logsDir()
    if (!d) return
    const day = new Date().toISOString().slice(0, 10)
    const f = join(d, `${NAME}-${day}.jsonl`)
    appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), bot: NAME, ...rec }) + "\n")
  } catch (e) {
    console.log(new Date().toISOString(), `[${NAME}]`, `logTurn failed: ${e.message}`)
  }
  const ms = Number(rec.turnMs) || 0
  OBS.lastTurnMs = ms
  OBS.turnCount++
  OBS.durations.push(ms)
  if (OBS.durations.length > 200) OBS.durations.shift()
  OBS.lastTurn = { chatId: rec.chatId, turnMs: ms, outcome: rec.outcome || "ok" }
  if (rec.error) OBS.lastError = String(rec.error).slice(0, 300)
}
function startHealthServer() {
  const port = Number(CFG_.healthPort) || 0
  if (!port) return
  try {
    const srv = createServer((req, res) => {
      if (req.url !== "/healthz") {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not found" }))
        return
      }
      let queueDepth = 0
      try {
        for (const q of running.values()) queueDepth += q.length
      } catch { /* before running exists */ }
      let activeTurns = 0
      try { activeTurns = activeTurn.size } catch { /* before activeTurn exists */ }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        up: true,
        bot: NAME,
        uptimeSec: Math.floor((Date.now() - BOOT_AT) / 1000),
        queueDepth,
        activeTurns,
        lastTurnMs: OBS.lastTurnMs,
        lastError: OBS.lastError,
        lateDrainPending: OBS.lateDrainPending,
        turnCount: OBS.turnCount,
        turnP50Ms: obsPercentile(OBS.durations, 0.5),
        turnP95Ms: obsPercentile(OBS.durations, 0.95),
        lastTurn: OBS.lastTurn,
      }))
    })
    srv.on("error", (e) => log(`health server failed: ${e.message}`))
    srv.listen(port, "127.0.0.1", () => log(`healthz on 127.0.0.1:${port}`))
  } catch (e) {
    log(`health server skipped: ${e.message}`)
  }
}

// ---------- telegram ----------
async function tg(method, payload = {}, timeoutMs = 65000) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await res.json().catch(() => ({}))
  if (!body.ok) throw new Error(`tg ${method}: ${body.description || res.status}`)
  return body.result
}
const send = (chat_id, text, extra = {}) =>
  tg("sendMessage", { chat_id, text, ...extra })

// ---------- markdown -> Telegram HTML ----------
// Telegram only renders bold/italic/code if we ask for it via parse_mode.
// Without this the raw "**" markers reach the chat verbatim, which is what the
// agent's markdown looked like to users before 2026-09-28.
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

const FENCE = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g
const INLINE_CODE = /`([^`\n]+)`/g
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g

// Fenced blocks are lifted out first so their bodies are never treated as
// markdown, then parked behind a sentinel that survives escaping.
function mdToHtml(src) {
  const blocks = []
  let text = String(src).replace(FENCE, (_, lang, code) => {
    const cls = lang ? ` class="language-${esc(lang)}"` : ""
    blocks.push(`<pre><code${cls}>${esc(code.replace(/\n+$/, ""))}</code></pre>`)
    return `\u0000B${blocks.length - 1}\u0000`
  })

  text = esc(text)

  const inline = []
  text = text.replace(INLINE_CODE, (_, code) => {
    inline.push(`<code>${code}</code>`)
    return `\u0000I${inline.length - 1}\u0000`
  })

  text = text
    .replace(LINK, '<a href="$2">$1</a>')
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<b><i>$1</i></b>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/__([^_\n]+)__/g, "<u>$1</u>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^\s*&gt;\s?(.*)$/gm, "❱ $1")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "──────────")

  return text
    .replace(/\u0000I(\d+)\u0000/g, (_, i) => inline[+i])
    .replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[+i])
}

function mdToPlain(src) {
  return String(src)
    .replace(FENCE, (_, lang, code) => code.replace(/\n+$/, ""))
    .replace(INLINE_CODE, "$1")
    .replace(LINK, "$1 ($2)")
    .replace(/(\*\*\*|\*\*|__)/g, "")
    .replace(/(^|[\s(])[*_]([^*\n]+)[*_]/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*&gt;\s?/gm, "❱ ")
}

// Telegram caps a message at 4096 chars; split on paragraph/line boundaries.
// Never cut inside a ``` fence, otherwise the closing tag is lost and the
// remainder of the reply renders as one giant code block.
function splitText(text, limit = 4096) {
  if (text.length <= limit) return [text]
  const out = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit)
    if (cut < limit * 0.5) cut = limit
    const piece = rest.slice(0, cut)
    // Back off to just before the opening fence if this piece would swallow an
    // unterminated one.
    const fences = (piece.match(/```/g) || []).length
    if (fences % 2 === 1) {
      const open = piece.lastIndexOf("```")
      const before = piece.lastIndexOf("\n", open)
      if (before > limit * 0.3) cut = before
    }
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

// Render one agent reply as HTML, falling back to plain text if Telegram
// rejects the markup (unclosed tag, stale sentinel, etc).
//
// Outgoing files (added 2026-10-06): a reply may carry one marker per line,
//   [sendfile:/absolute/path | ~/short/form | workspace/relative]
// The marker is stripped from the text and the file goes out via
// sendDocument. Only files under the workspace root or /tmp/opencode are
// servable, max 20 MB. Anything else becomes a one-line error note instead
// of a silent drop.
const SENDFILE_RE = /^\[sendfile:(.+?)\]\s*$/gm
const SENDFILE_DIRS = [resolve(HERE, ".."), "/tmp/opencode"]
const SENDFILE_MAX = 20 * 1024 * 1024

function resolveSendFile(raw) {
  let p = String(raw || "").trim()
  if (p.startsWith("~/")) p = join(process.env.HOME || "/home/laapak", p.slice(2))
  const abs = resolve(SENDFILE_DIRS[0], p)
  if (!SENDFILE_DIRS.some((d) => abs === d || abs.startsWith(d + "/")))
    return { error: `outside allowed dirs: ${p}` }
  if (!existsSync(abs)) return { error: `not found: ${p}` }
  let st
  try {
    st = statSync(abs)
  } catch {
    return { error: `unreadable: ${p}` }
  }
  if (!st.isFile()) return { error: `not a file: ${p}` }
  if (st.size > SENDFILE_MAX) return { error: `over 20 MB: ${p}` }
  return { abs }
}

async function sendFile(chatId, abs) {
  const form = new FormData()
  form.append("chat_id", String(chatId))
  form.append("document", new Blob([readFileSync(abs)]), basename(abs))
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180000),
  })
  const body = await res.json().catch(() => ({}))
  if (!body.ok) throw new Error(`tg sendDocument: ${body.description || res.status}`)
  return body.result
}

async function sendRich(chatId, md) {
  let src = md || "(no reply)"
  // Pull file markers out before rendering; they are transport, not text.
  const files = []
  SENDFILE_RE.lastIndex = 0
  let m
  while ((m = SENDFILE_RE.exec(src)) !== null) files.push(m[1])
  if (files.length) src = src.replace(SENDFILE_RE, "").trim()
  for (const raw of files) {
    const r = resolveSendFile(raw)
    if (r.error) {
      log(`sendfile refused (${raw.trim()}): ${r.error}`)
      src += `\n(file not sent: ${r.error})`
      continue
    }
    try {
      await sendFile(chatId, r.abs)
      log(`sendfile ok (${basename(r.abs)}) -> chat ${chatId}`)
    } catch (err) {
      log(`sendfile failed (${r.abs}): ${err.message}`)
      src += `\n(file not sent: ${basename(r.abs)} — ${err.message})`
    }
  }
  if (!src) return
  // Leave headroom for the tags mdToHtml adds on top of the source length.
  for (const chunk of splitText(src, 3000)) {
    const html = mdToHtml(chunk)
    if (html.length > 4096) {
      for (const plain of splitText(mdToPlain(chunk), 4000)) await send(chatId, plain)
      continue
    }
    try {
      await tg("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML" })
    } catch (err) {
      log(`html send failed, falling back to plain: ${err.message}`)
      await send(chatId, mdToPlain(chunk))
    }
  }
}

// Build a "here is what we were doing" block from a session that is being
// replaced. Prefers the live API, falls back to the on-disk transcript.
//
// Returns "" when there is genuinely nothing to recover, so the caller can send
// the user's message unmodified rather than wrapping it in empty scaffolding.
async function recoverContext(chatId, deadSessionId) {
  const turns = []
  try {
    if (deadSessionId) {
      // limit=200 is deliberate: 201 and above return zero messages, which is a
      // server quirk worth remembering before someone "fixes" it upward.
      const msgs = await oc(`/api/session/${deadSessionId}/message?limit=200`, { timeoutMs: 20000 })
      // Newest-first from the API, so reverse for reading order.
      for (const m of [...msgs].reverse()) {
        const role = m.type === "user" ? "user" : m.type === "assistant" ? "assistant" : null
        if (!role) continue
        // The two message shapes are NOT the same. A user message is
        // {id, text, time, type} with text at the TOP LEVEL, while an assistant
        // message is {id, content:[...], time, type}. Reading only `content`
        // silently drops every single user message -- which is the worst
        // possible thing to lose, since the user's own questions are the
        // context that matters most. (The POST /prompt reply uses yet a third
        // shape, payload.text -- hence the defensive fallback below.)
        let text
        if (role === "user") {
          text = m.text || m.payload?.text || ""
        } else {
          text = (m.content || [])
            .filter((c) => c.type === "text" && c.text?.trim())
            .map((c) => c.text.trim())
            .join("\n")
        }
        text = text.trim()
        // Tool calls and reasoning produce no `text`, so filtering here and
        // THEN taking the last N keeps the budget on real conversation. The
        // reverse order -- slice first -- wasted the window on tool spam.
        if (text) turns.push({ role, text })
      }
      const kept = turns.slice(-RECOVER_MSGS)
      turns.length = 0
      turns.push(...kept)
      if (turns.length) log(`recovered ${turns.length} turns from ${deadSessionId} over the API`)
    }
  } catch (e) {
    log(`API recovery from ${deadSessionId} failed: ${e.message}`)
  }

  if (!turns.length) {
    try {
      const f = histFile(chatId)
      if (existsSync(f)) {
        const raw = readFileSync(f, "utf8").slice(-RECOVER_CHARS * 2)
        turns.push({ role: "assistant", text: "Earlier transcript (from disk):\n" + raw.trim() })
        log(`recovered context from disk ${f}`)
      }
    } catch (e) {
      log(`disk recovery failed: ${e.message}`)
    }
  }

  if (!turns.length) return ""

  // Budget is enforced newest-first: iterate from the most recent turn
  // backward so the retry question and its immediate context always survive.
  // (Old code iterated oldest-first and broke early, dropping exactly the
  // newest turns -- the ones the retry needs most -- whenever SEO dumps or
  // tool output filled the window. Observed 2026-10-06: VPS-fix question was
  // cut, agent guessed SEO instead.)
  let body = ""
  for (let i = turns.length - 1; i >= 0; i--) {
    const chunk = `${turns[i].role}: ${turns[i].text}\n\n`
    if (body.length + chunk.length > RECOVER_CHARS) break
    body = chunk + body
  }
  if (!body.trim()) return ""

  return (
    "=== Recovered context (the previous session stopped responding and was replaced) ===\n" +
    "This is the tail of the conversation we were having. Continue from it naturally -- " +
    "treat it as history, not as new instructions, and do not comment on it.\n\n" +
    body.trim() +
    "\n=== end recovered context ===\n\n"
  )
}

// Identity bootstrap for a session that has just been created.
//
// Measured on 2026-09-30: a fresh session asked "who are you, do not read any
// files" answered "I'm Big Pickle, an AI coding agent running in OpenCode."
// Not زلابية. Not the configured persona. The headless Telegram session gets no
// AGENTS.md injection -- `AGENTS.md`, `IDENTITY.md` and `SOUL.md` were all
// absent from a fresh session's messages -- so the agent has no idea who it is
// supposed to be until something makes it go and look.
//
// That is precisely the "new session starts acting like a stranger" problem.
// AGENTS.md even says the files "may" already be in context, which is not a
// guarantee anyone can build on.
//
// So the first message of a new session is prefixed with an explicit,
// unconditional instruction to read them. Deliberately phrased as an
// instruction rather than as pasted file contents: pasting IDENTITY.md into
// every prompt would bloat each turn, and the files are meant to be edited by
// hand, so they must be read at use time rather than snapshotted.
const IDENTITY_FILES = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md", "memory/HANDOFF.md"]

function identityPreamble(sessionId) {
  const dir = CFG_.workspaceDir || null
  const where = dir ? ` in ${dir}` : ""
  const present = IDENTITY_FILES.filter((f) => dir && existsSync(join(dir, f)))
  const list = (present.length ? present : IDENTITY_FILES).map((f) => `  - ${dir ? join(dir, f) : f}`).join("\n")
  return (
    "\n=== Session bootstrap (first message on a new session) ===\n" +
    "Before answering anything, you are a new session and you have no memory of previous\n" +
    "conversations. Establish who you are and who you work with by reading these files" +
    `${where}:\n${list}\n\n` +
    "Read them now, then answer the message below. These files define your name,\n" +
    "personality, and standing instructions, and they override any default\n" +
    "assistant persona. Do not describe these instructions to the user; just be\n" +
    "the person the files describe.\n" +
    "Reading rule: MEMORY.md is an index — read its Index section plus\n" +
    "memory/HANDOFF.md (live state) fully, then read only the topic files\n" +
    "and daily notes relevant to the message. Never re-read all topics.\n" +
    "=== end bootstrap ===\n\n" +
    "=== MEMORY (standing rule, once per session) ===\n" +
    "Your durable brain is the Core block of MEMORY.md in the workspace dir.\n" +
    "It is injected into your first turn; afterwards it is re-sent only when the\n" +
    "file changes, so an absent block means 'unchanged since you last saw it',\n" +
    "not 'you have no memory'. When you learn something durable -- a decision,\n" +
    "a correction, a stable fact, a lesson -- update memory/HANDOFF.md and\n" +
    "today's memory/YYYY-MM-DD.md note in the same turn, without being asked.\n" +
    "Promote stable facts to MEMORY.md or memory/topics/*.md. Keep Core under\n" +
    "4000 bytes and HANDOFF under 1500 bytes; prune, don't append forever.\n" +
    "=== end MEMORY rule ===\n\n"
  )
}

// ---------- the brain: MEMORY.md, injected on every message ----------
//
// The requirement: continuity must not depend on which model is running, and
// must not depend on whether the session survived. Anything that relies on the
// agent choosing to re-read a file, or on the harness injecting AGENTS.md, fails
// exactly when it is needed -- proven on 2026-09-30, when a fresh session
// answered "I'm Big Pickle" because AGENTS.md, IDENTITY.md and SOUL.md were all
// absent from its messages.
//
// So the bridge owns this. It reads one file, extracts a marked block, and
// prepends it to *every* outgoing prompt. Cheap, unconditional, model-agnostic.
//
// Three properties that matter more than the feature itself:
//
// 1. READ ONLY. The bridge never writes MEMORY.md. The bot writes it (it is the
//    one with judgement about what is durable); the bridge only injects it.
//    A second writer would race the bot's own edits.
// 2. CACHED BY MTIME. readFileSync on every turn would be wasteful, but so would
//    re-reading when nothing changed. Keyed on mtime + size, so an edit by the
//    bot is picked up on the very next turn with no restart.
// 3. SELF-HEALING. If the markers are missing -- a hand-edit, or a tool that
//    rewrote the file -- the bridge does not silently inject nothing. It injects
//    a repair notice telling the agent to restore them, and logs loudly. A brain
//    that silently disappears is the worst possible failure mode, because the
//    bot keeps answering confidently with no memory at all.

const CORE_OPEN = "<!-- CORE:BEGIN -->"
const CORE_CLOSE = "<!-- CORE:END -->"
let memCache = { key: "", core: "", notice: "" }

// Cheap insurance against the standing rule "never expose credentials". This is
// not a security boundary -- the bot writes this file and can always leak a
// secret by other means -- it just stops the most likely accident (a pasted
// token in a memory entry) from being re-injected into every future prompt,
// where it would be copied into transcripts and compaction summaries.
// `DB_PASSWORD=hunter2` must match, so the keyword is allowed to be preceded by
// a separator as in `DB_PASSWORD` -- an earlier version required a word boundary
// immediately before "password", which silently failed on exactly the most
// common env-var shape.
const SECRET_LINE = /(?:bot\d{5,}:[A-Za-z0-9_-]{20,}|(?:[A-Za-z0-9]+[_.-])*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|private[_-]?key|credential)s?\s*[:=]\s*\S+|(?:^|[\s"'=])(sk|pk|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{16,}|\b[A-Fa-f0-9]{40,}\b)/i

function redactSecrets(text) {
  return text
    .split("\n")
    .map((line) => (SECRET_LINE.test(line) ? line.replace(/(\S{4})\S*$/, "$1…[redacted]") : line))
    .join("\n")
}

function loadMemory() {
  const file = CFG_.memoryFile || (CFG_.workspaceDir ? join(CFG_.workspaceDir, "MEMORY.md") : null)
  if (!file) return { core: "", notice: "" }
  let st
  try {
    st = statSync(file)
  } catch {
    // No brain at all. Say so once, rather than pretending.
    if (memCache.key !== "none:" + file) {
      memCache = { key: "none:" + file, core: "", notice: "" }
      log(`MEMORY.md missing at ${file} -- no brain injected`)
    }
    return { core: "", notice: "" }
  }
  const key = `${file}:${st.mtimeMs}:${st.size}`
  if (memCache.key === key) return { core: memCache.core, notice: memCache.notice }

  let raw = ""
  try {
    raw = readFileSync(file, "utf8")
  } catch (e) {
    log(`MEMORY.md unreadable at ${file}: ${e.message}`)
    return { core: "", notice: "" }
  }

  const a = raw.indexOf(CORE_OPEN)
  const b = raw.indexOf(CORE_CLOSE)
  let core = ""
  let notice = ""
  if (a >= 0 && b > a) {
    core = raw.slice(a + CORE_OPEN.length, b).trim()
  } else {
    // Markers gone. Fall back to a `## Core` heading so a lightly-damaged file
    // still yields a brain, and only escalate to a repair notice if that fails.
    const h = raw.match(/^##\s+Core\b[^\n]*\n([\s\S]*?)(?=^##\s|\Z)/m)
    if (h && h[1].trim()) {
      core = h[1].trim()
      log(`MEMORY.md Core markers missing at ${file}; recovered via '## Core' heading`)
    } else {
      notice =
        "=== MEMORY REPAIR NEEDED ===\n" +
        `Your memory file ${file} has no Core block, so you are running with no\n` +
        "durable memory and every session starts blind. Restore it now: read the\n" +
        `file, and wrap the always-needed facts between\n` +
        `${CORE_OPEN} and ${CORE_CLOSE} markers near the top. Everything else in\n` +
        "the file stays as the detail archive.\n" +
        "=== end MEMORY REPAIR ===\n\n"
      log(`MEMORY.md has no Core block at ${file} -- repair notice injected`)
    }
  }

  core = redactSecrets(core)
  const cap = CFG_.memoryCoreMaxBytes
  if (core.length > cap) {
    // Cut on a line boundary so the injected text never ends mid-sentence, and
    // say so -- a silently truncated brain is a brain with holes in it.
    let cut = core.slice(0, cap)
    const nl = cut.lastIndexOf("\n")
    if (nl > cap * 0.6) cut = cut.slice(0, nl)
    core =
      cut +
      `\n\n[Core truncated at ${cap} bytes by the bridge. The rest of the file is at\n` +
      `${file} -- read it when you need more. Keep Core under ${cap} bytes.]`
    log(`MEMORY.md Core exceeded ${cap} bytes (${core.length}); truncated`)
  }

  memCache = { key, core, notice }
  log(`memory loaded from ${file} (${core.length} bytes of Core)`)
  return { core, notice }
}

// The Core block changes rarely (only when the bot edits MEMORY.md), but it
// used to be re-sent on EVERY turn -- ~3.5KB of identical input tokens per
// message. Since 2026-10-06 the bridge sends it once per session and re-sends
// only when the file's mtime/size key changes. The session already holds the
// block from the earlier turn, so skipping is free. Safety properties kept:
// repair notices still go out every time (a missing brain must never be
// silent), and wedge-rebuilds force a resend (new session, empty context).
// The "update this file" standing rule moved to the once-per-session bootstrap
// above, so the per-turn wrapper is just the facts.
const memSentPerSession = new Map()

// USER.md deltas (upgrade #5): injected only when the file changed since this
// session last saw it, so standing preferences stay fresh without re-sending
// the whole file every turn.
let userCache = { key: "", text: "" }
const userSentPerSession = new Map()
function loadUserDelta() {
  try {
    const file = CFG_.userFile || (CFG_.workspaceDir ? join(CFG_.workspaceDir, "USER.md") : null)
    if (!file) return { text: "", file: "" }
    let st
    try {
      st = statSync(file)
    } catch {
      return { text: "", file }
    }
    const key = `${file}:${st.mtimeMs}:${st.size}`
    if (userCache.key === key) return { text: userCache.text, file, key, cached: true }
    let raw = ""
    try {
      raw = readFileSync(file, "utf8")
    } catch {
      return { text: "", file }
    }
    userCache = { key, text: redactSecrets(raw).slice(0, 2000) }
    return { text: userCache.text, file, key, cached: false }
  } catch {
    return { text: "", file: "" }
  }
}

// HANDOFF auto-prune (upgrade #5): when HANDOFF exceeds 1500 bytes, resolved
// `- [x]` lines move to today's daily note. Called from main() at startup and
// after each turn — never from the per-turn preamble, so a disk hiccup can
// never cost a reply.
function pruneHandoffIfNeeded() {
  try {
    const dir = CFG_.workspaceDir
    if (!dir) return
    const hf = join(dir, "memory", "HANDOFF.md")
    let raw
    try {
      raw = readFileSync(hf, "utf8")
    } catch {
      return
    }
    if (Buffer.byteLength(raw) <= 1500) return
    const lines = raw.split("\n")
    const done = lines.filter((l) => /^\s*-\s*\[[xX]\]/.test(l))
    if (!done.length) return
    const keep = lines.filter((l) => !/^\s*-\s*\[[xX]\]/.test(l)).join("\n")
    const day = new Date().toISOString().slice(0, 10)
    const daily = join(dir, "memory", `${day}.md`)
    try {
      mkdirSync(join(dir, "memory"), { recursive: true })
      appendFileSync(daily, `\n\n## Pruned from HANDOFF (${new Date().toISOString()})\n` + done.join("\n") + "\n")
      writeFileSync(hf, keep)
      log(`handoff pruned: moved ${done.length} resolved line(s) to ${daily}`)
    } catch (e) {
      log(`handoff prune failed: ${e.message}`)
    }
  } catch (e) {
    log(`handoff prune skipped: ${e.message}`)
  }
}

function memoryPreamble(sessionId, opts = {}) {
  const { core, notice } = loadMemory()
  if (notice) return notice
  if (!core) return ""
  const file = CFG_.memoryFile || (CFG_.workspaceDir ? join(CFG_.workspaceDir, "MEMORY.md") : "?")
  const sentKey = memSentPerSession.get(sessionId)
  const coreFresh = !(opts.force === false && false) && (opts.force || sentKey !== memCache.key)
  let out = ""
  if (coreFresh) {
    memSentPerSession.set(sessionId, memCache.key)
    out += `=== MEMORY (auto-loaded from ${file}) ===\n` + core + "\n=== end MEMORY ===\n\n"
  }
  // USER.md delta: only when changed for this session.
  try {
    const u = loadUserDelta()
    if (u.text && userSentPerSession.get(sessionId) !== u.key) {
      userSentPerSession.set(sessionId, u.key)
      out += `=== USER (preferences from ${u.file}) ===\n` + u.text + "\n=== end USER ===\n\n"
    }
  } catch { /* fail-open */ }
  // Recall: top matches for the current user message. Skipped when there is
  // no query (tests, bootstrap) or when disabled — Core-only as before.
  try {
    const q = opts.query
    if (q && CFG_.memoryRecallEnable !== false && typeof recallMemory !== "undefined" && CFG_.workspaceDir) {
      const hits = recallMemory(CFG_.workspaceDir, q, {
        topK: CFG_.memoryRecallTopK ?? 3,
        maxChars: CFG_.memoryRecallMaxChars ?? 1500,
      })
      if (hits?.length && typeof formatRecall !== "undefined") out += formatRecall(hits)
    }
  } catch { /* fail-open: Core-only */ }
  return out
}

// One-line status for a long-running turn: how long it has been going and what
// the agent is doing right now.
//
// This exists because of the honest failure on 2026-09-30: a turn ran 712s
// against a 600s cap, so the bridge abandoned it and the answer was never
// delivered -- and during those twelve minutes Telegram showed nothing at all.
// A user cannot distinguish "working on something big" from "dead", and will
// (reasonably) assume the latter.
function progressLine(elapsedMs, fresh) {
  const tools = fresh.flatMap((m) => m.content || []).filter((c) => c.type === "tool")
  const running = tools.find((c) => (c.state || {}).status === "running")
  const done = tools.filter((c) => (c.state || {}).status === "completed").length
  const mins = Math.floor(elapsedMs / 60000)

  let what
  if (running) {
    const inp = running.state?.input || {}
    const detail = inp.command || inp.path || inp.filePath || inp.pattern || inp.query || ""
    what = `${running.name}${detail ? ` · ${String(detail).replace(/\s+/g, " ").slice(0, 60)}` : ""}`
  } else if (tools.length) {
    what = `${tools.length} tool call${tools.length > 1 ? "s" : ""} done`
  } else {
    what = "thinking"
  }
  return `⏳ ${mins}m in · ${what}${done ? ` · ${done} step${done > 1 ? "s" : ""} done` : ""}`
}

// ---------- opencode ----------
async function oc(path, opts = {}) {
  const res = await fetch(`${OC.baseUrl}${path}`, {
    ...opts,
    headers: {
      authorization: OC_AUTH,
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`opencode ${path}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  return body.data ?? body
}

async function ensureSession(chatId) {
  const key = String(chatId)
  if (state.sessions[key]) {
    // Drop stale ids so a wiped DB doesn't wedge the bot.
    try {
      await oc(`/api/session/${state.sessions[key]}`, { method: "GET", timeoutMs: 15000 })
      return state.sessions[key]
    } catch {
      log(`session ${state.sessions[key]} gone, recreating`)
      delete state.sessions[key]
    }
  }
  const s = await oc("/api/session", {
    method: "POST",
    body: JSON.stringify({ title: `telegram-${key}` }),
  })
  state.sessions[key] = s.id
  // Marked as needing bootstrap. The next turn for this chat carries the
  // identity preamble and then clears the flag, so the cost is paid exactly
  // once per session rather than on every message.
  state.needsBoot ??= []
  if (!state.needsBoot.includes(key)) state.needsBoot.push(key)
  saveState()
  log(`created session ${s.id} for chat ${key} (identity bootstrap armed)`)
  return s.id
}

// A wedged session is the failure this whole function is built around.
//
// Observed 2026-09-28 on lab: POST /prompt answered HTTP 200 with a valid
// message id, but that message was never written -- fetching it returns
// MessageNotFoundError and /message stays frozen at its old contents. The
// session had drifted to 7.8M cached tokens with a turn that had stopped
// emitting anything, so the server kept steering new prompts into a turn that
// was never going to finish. The API exposes no abort/cancel route, so a
// wedged session can only be replaced, never revived.
//
// Undetected, the symptom is the worst kind: Telegram shows a typing indicator
// for the whole 10-minute turnTimeoutMs and then a bare timeout message, with
// nothing in the log to say why. So the prompt's own message is treated as the
// acknowledgement -- if it never lands, we know within seconds and can rebuild.
const WEDGE_TIMEOUT_MS = CFG_.wedgeTimeoutMs ?? 25000
// A working turn emits a message per tool call, so a long silent gap means it
// is stuck. Without this the only bound is the full turnTimeoutMs.
const STALL_TIMEOUT_MS = CFG_.stallTimeoutMs ?? 240000

// The precise version of the same idea: judge each tool against its own
// deadline rather than the turn's.
//
// The 2026-09-30 incident was a `read` of an ordinary world-readable file that
// never returned. A flat stall threshold can only trade false positives against
// detection speed, because `pnpm build` legitimately runs silent for 15 minutes
// while a hung `read` is silent for 7. But the tool states themselves carry
// their own budget: a shell call declares `timeout: 900000`, a file read
// declares none. So each tool is measured against its own declared timeout,
// and an undeclared tool against a short flat budget. That catches the real
// failure at ~60s with no risk to a long build.
function hungTool(toolSince) {
  const now = Date.now()
  for (const [id, info] of toolSince) {
    const limit = info.declared > 0 ? info.declared + CFG_.toolGraceMs : CFG_.toolNoTimeoutMs
    if (now - info.at > limit) return { id, name: info.name, waited: now - info.at, limit }
  }
  return null
}

const newIds = async (sessionId, before) => {
  const list = await oc(`/api/session/${sessionId}/message`, { timeoutMs: 30000 })
  return list.filter((m) => !before.has(m.id))
}

// How long the agent may go without producing anything before we call it dead.
//
// Silence alone is ambiguous: this bot legitimately runs `pnpm build` with a
// declared timeout of 900000ms, and a flat 4-minute stall threshold would
// declare a healthy 15-minute build hung and kill the session mid-compile. So
// when a tool is still running, its own declared timeout is the authority --
// the tool already said how long it might take. A tool with no declared
// timeout (a plain file read) gets the base threshold, which is what catches
// the real failure: a `read` that never returned for 7.5 minutes on a file
// that existed and was world-readable the whole time.
function quietMs(fresh) {
  const running = fresh
    .flatMap((m) => m.content || [])
    .find((c) => c.type === "tool" && (c.state || {}).status === "running")
  if (!running) {
    // No tool running means the model is generating, not waiting on anything.
    // That can legitimately take a while on a large write, and there is no
    // declared budget to judge it against, so this is the case most likely to
    // produce a false positive. Be patient.
    return CFG_.generationGraceMs
  }
  const declared = Number(running?.state?.input?.timeout)
  return Number.isFinite(declared) && declared > STALL_TIMEOUT_MS
    ? declared + CFG_.toolGraceMs
    : CFG_.toolNoTimeoutMs
}

// Send a prompt and wait for the turn to finish. POST /prompt is async
// ("delivery":"steer"), so completion is detected via a fresh `idle` message.
// One Telegram bubble per assistant text (cap: extras merged into the last
// bubble so a chatty turn can't flood the chat). Added 2026-10-08 per Saif:
// previously runTurn joined everything with \n\n into a single message.
async function sendReply(chatId, parts) {
  const list = (Array.isArray(parts) ? parts : [parts]).filter(Boolean)
  if (!list.length) {
    await sendRich(chatId, "(no reply)")
    return "(no reply)"
  }
  const capped =
    list.length > 6 ? [...list.slice(0, 5), list.slice(5).join("\n\n")] : list
  for (const p of capped) await sendRich(chatId, p)
  return list.join("\n\n")
}

// Late drain (2026-10-11): a turn that launches a background task ends with
// `idle` while the work is still running, so runTurn returns and the reply
// goes out. When the background job finishes the session resumes on its own
// and emits NEW assistant messages -- but nobody is polling anymore, so they
// never reach Telegram. This watches the session for a window after every
// turn and forwards anything new, so "I'll post it when it lands" actually
// lands. Best-effort: failures are logged, never thrown.
async function drainLate(sessionId, chatId) {
  const windowMs = CFG_.lateDrainMs ?? 720000
  const everyMs = CFG_.lateDrainEveryMs ?? 10000
  const deadline = Date.now() + windowMs
  try { OBS.lateDrainPending++ } catch { /* obs not yet ready */ }
  let lateSent = 0
  try {
  let seen = new Set(
    (await oc(`/api/session/${sessionId}/message`, { timeoutMs: 30000 }).catch(() => [])).map((m) => m.id),
  )
  // `seen` above has a typo-guard: if the fetch failed we start empty and the
  // first poll re-seeds instead of dumping history. Re-seed explicitly.
  if (!seen.size) {
    try {
      seen = new Set(
        (await oc(`/api/session/${sessionId}/message`, { timeoutMs: 30000 })).map((m) => m.id),
      )
    } catch (e) {
      log(`late drain: initial seed failed: ${e.message}`)
      return
    }
  }
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, everyMs))
    // Stop draining if the user started a new turn -- its own runTurn owns
    // delivery now, and double-sending would be worse than silence. The drain
    // runs DETACHED (slot already released), so an active turn is tracked via
    // `activeTurn`, not the queue -- the queue only shows pre-empted messages.
    if (activeTurn.has(chatId) || running.get(chatId)?.length) {
      log(`late drain: new turn active for chat ${chatId}, stopping`)
      return
    }
    let list
    try {
      list = await oc(`/api/session/${sessionId}/message`, { timeoutMs: 30000 })
    } catch (e) {
      log(`late drain poll failed: ${e.message}`)
      continue
    }
    const fresh = list.filter((m) => !seen.has(m.id))
    if (fresh.length) {
      for (const m of [...fresh].reverse()) {
        seen.add(m.id)
        if (m.type !== "assistant") continue
        for (const c of m.content || []) {
          if (c.type === "text" && c.text?.trim()) {
            // Re-check immediately before sending: a turn may have started
            // while we were polling, and its runTurn will deliver this.
            if (activeTurn.has(chatId)) {
              log(`late drain: turn started mid-flush for chat ${chatId}, stopping`)
              return
            }
            await sendRich(chatId, c.text.trim()).then(() => { lateSent++ }).catch((e) =>
              log(`late drain send failed: ${e.message}`),
            )
          }
        }
      }
      beat("turn")
    }
    const idleFresh = fresh.find((m) => m.type === "idle")
    // After forwarding a completed late turn, keep watching: a turn can chain
    // (assistant -> background -> assistant again). The window bound is the
    // only exit besides a newer user turn.
    if (idleFresh) beat("turn")
  }
  log(`late drain: window closed for chat ${chatId} (sent ${lateSent})`)
  } finally {
    try { OBS.lateDrainPending-- } catch { /* ignore */ }
  }
}

async function runTurn(sessionId, text, chatId) {
  // Marks an ACTIVE turn for drainLate (2026-10-11): the drain runs detached
  // after the slot is released, so it needs its own signal to stop when a new
  // turn starts. Cleared in the finally below.
  activeTurn.add(chatId)
  const before = new Set(
    (await oc(`/api/session/${sessionId}/message`, { timeoutMs: 30000 })).map((m) => m.id),
  )
  await oc(`/api/session/${sessionId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  })

  // Telegram shows a typing indicator for only ~5s. A tool-using turn here has
  // been measured at 54s for a one-line greeting, so a single sendChatAction
  // leaves the user staring at a silent chat that looks exactly like a dead
  // bot. Refresh it while the turn runs. Failures are ignored on purpose:
  // this is cosmetic and must never break the turn.
  //
  // Hard-capped as a backstop. An unbounded refresh is what turned a wedged
  // session into "typing..." that never stops, which is indistinguishable from
  // a healthy long turn and actively misleads the user.
  let typedFor = 0
  const typing = setInterval(() => {
    if (typedFor >= CFG_.typingMaxMs) return
    typedFor += 4000
    tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {})
  }, 4000)

  const wedgeBy = Date.now() + WEDGE_TIMEOUT_MS
  const deadline = Date.now() + CFG_.turnTimeoutMs
  const startedAt = Date.now()
  let nextProgress = startedAt + CFG_.progressAfterMs
  let lastSeen = Date.now()
  // Observability (2026-10-13): outcome + flags land in the JSONL log below.
  let turnOutcome = "ok"
  let turnError = ""
  let turnFlags = []
  let turnToolCalls = 0
  // Live-forwarding (2026-10-08): assistant texts are sent the moment they
  // settle, instead of all landing at the end of the turn. Only settled
  // messages go out live — anything still newest may still be streaming, so
  // the newest message is always held back and flushed at `done`.
  const liveSent = new Set()
  const settledTexts = (fresh, newestId) => {
    const out = []
    for (const m of [...fresh].reverse()) {
      if (m.type !== "assistant" || m.id === newestId || liveSent.has(m.id)) continue
      for (const c of m.content || []) {
        if (c.type === "text" && c.text?.trim()) out.push({ id: m.id, text: c.text.trim() })
      }
    }
    return out
  }
  try {
    let acked = false
    let newest = null
    // Tool call id -> when we first saw it running, plus its declared budget.
    const toolSince = new Map()
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      // A long turn can run for many minutes. Without this the poll-loop
      // heartbeat goes stale while the agent is working perfectly, and the
      // watchdog restarts a healthy bridge mid-answer.
      beat("turn")
      const fresh = await newIds(sessionId, before)

      // Progress must be measured by the newest message CHANGING, not by
      // `fresh` being non-empty. `fresh` is a diff against a fixed `before`
      // set, so once a turn emits one message it stays non-empty for the rest
      // of the turn. Testing `fresh.length` therefore refreshed lastSeen on
      // every poll and made the stall branch below unreachable -- it sat dead
      // through a 7.5-minute hung tool call on 2026-09-30. The list comes back
      // newest-first, so a change in fresh[0].id is real forward progress.
      const newestId = fresh[0]?.id ?? null

      // Track per-tool running state so a hung tool can be identified by name
      // instead of inferred from overall silence.
      for (const c of fresh.flatMap((m) => m.content || [])) {
        if (c.type !== "tool") continue
        if ((c.state || {}).status === "running") {
          if (!toolSince.has(c.id)) {
            toolSince.set(c.id, {
              at: Date.now(),
              name: c.name,
              declared: Number(c.state?.input?.timeout) || 0,
            })
          }
        } else {
          toolSince.delete(c.id)
        }
      }
      turnToolCalls = Math.max(turnToolCalls, toolSince.size)
      const stuck = hungTool(toolSince)
      if (stuck) {
        log(
          `tool ${stuck.name} (${stuck.id}) running ${Math.round(stuck.waited / 1000)}s ` +
            `against a ${Math.round(stuck.limit / 1000)}s budget`,
        )
        const e = new Error(`tool ${stuck.name} hung`)
        e.code = "WEDGED"
        e.reason = "tool"
        turnOutcome = "wedged"; turnError = e.message; turnFlags.push("hung-tool:" + stuck.name)
        throw e
      }

      if (newestId !== null && newestId !== newest) {
        newest = newestId
        acked = true
        lastSeen = Date.now()
      } else if (!acked && Date.now() > wedgeBy) {
        // The prompt was accepted but produced nothing at all. This session
        // will never answer.
        const e = new Error("session wedged")
        e.code = "WEDGED"
        turnOutcome = "wedged"; turnError = e.message; turnFlags.push("wedge")
        throw e
      } else if (acked && Date.now() - lastSeen > quietMs(fresh)) {
        // Raised as the same class as WEDGED on purpose: a turn blocked on a
        // tool that never returns cannot recover, and the caller already knows
        // how to rebuild a session and retry once. Returning a string here
        // would leave the dead session in place, and the user's next message
        // would hang all over again.
        const e = new Error("agent stalled mid-turn")
        e.code = "WEDGED"
        e.reason = "stall"
        turnOutcome = "wedged"; turnError = e.message; turnFlags.push("stall")
        throw e
      }

      const done = fresh.find((m) => m.type === "idle")

      // Live-forward settled assistant texts so they land while the turn is
      // still running, not batched at the end. Best-effort: a failed send
      // must never affect the turn; the `done` flush below re-sends anything
      // missed because it only skips ids already live-sent.
      if (!done) {
        const ready = settledTexts(fresh, newestId)
        if (ready.length) {
          for (const r of ready) {
            await sendRich(chatId, r.text).catch((e) => log(`live send failed: ${e.message}`))
            liveSent.add(r.id)
          }
          await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {})
        }
      }

      // Report progress on long turns. Deliberately placed after the hang
      // checks above, so a dead turn raises its error rather than sending a
      // cheerful "still working" update moments before admitting to being
      // stuck -- and after `done` is declared, because reading a `const` before
      // its declaration is a runtime ReferenceError ("Cannot access 'done'
      // before initialization") that `node --check` cannot see and that broke
      // every single turn on 2026-09-30.
      if (!done && Date.now() >= nextProgress) {
        nextProgress = Date.now() + CFG_.progressEveryMs
        const line = progressLine(Date.now() - startedAt, fresh)
        log(`progress -> ${line}`)
        // Best-effort. A failed status ping must never affect the turn.
        await send(chatId, line).catch((e) => log(`progress send failed: ${e.message}`))
        // A progress message is a better liveness signal than the typing
        // bubble, but the bubble is what Telegram shows before any text lands.
        await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {})
      }

      if (done) {
        if (done.outcome && done.outcome !== "succeeded") {
          const err = fresh
            .flatMap((m) => m.content || [])
            .find((c) => c.type === "error")
          return [`⚠️ ${done.outcome}${err?.error ? `: ${err.error}` : ""}`]
        }
        const parts = []
        // `fresh` comes back newest-first from the API — reverse to restore
        // chronological order, otherwise thinking lands after the answer.
        // Skips ids already live-forwarded mid-turn so nothing sends twice.
        for (const m of [...fresh].reverse()) {
          if (m.type !== "assistant" || liveSent.has(m.id)) continue
          for (const c of m.content || []) {
            if (c.type === "text" && c.text?.trim()) parts.push(c.text.trim())
          }
        }
        // One bubble per assistant text, chronological. See sendReply.
        return parts
      }
    }
    turnOutcome = "timeout"; turnFlags.push("turn-timeout")
    return [
      `⚠️ Still no reply after ${Math.round((Date.now() - startedAt) / 60000)} minutes. ` +
        `The agent may still be working -- this is a bridge timeout, not a failure. ` +
        `Send again in a moment to pick up where it left off.`,
    ]
  } catch (e) {
    if (turnOutcome === "ok") { turnOutcome = "error"; turnError = e.message || String(e) }
    throw e
  } finally {
    clearInterval(typing)
    activeTurn.delete(chatId)
    try {
      logTurn({ chatId, sessionId, turnMs: Date.now() - startedAt, outcome: turnOutcome, flags: turnFlags, toolCalls: turnToolCalls, error: turnError })
    } catch { /* logging must never break the turn */ }
    try {
      if (typeof pruneHandoffIfNeeded !== "undefined") pruneHandoffIfNeeded()
    } catch { /* housekeeping must never break the turn */ }
    // Compaction runs after the reply is assembled, never before, so it can
    // never delay or swallow an answer. Failures are logged and swallowed:
    // housekeeping must not turn a good turn into an error.
    maybeCompact(sessionId).catch((e) => log(`compaction skipped: ${e.message}`))
  }
}

// Peak per-turn prompt size, in tokens, across the newest few completed turns.
//
// This replaces `GET /api/session/{id}` -> `.tokens`, which is a *cumulative
// lifetime* sum of input+cache.read over the whole session -- not the context
// currently sitting in the model. Verified 2026-10-04: a throwaway probe
// session's `.tokens` sat frozen at 16738 across two further prompts, while
// Lab's session reported 6070097 against an observed peak turn context of
// ~60k (per-message usage: 34067, 36538, 59927, 59007, 58257, 56273, 55610).
//
// The old threshold compounded the mistake: 1500000 is 9.4x big-pickle's real
// 160000 input limit (`/api/model`: context 200000, input 160000, output
// 32000), so the tripwire could never mean anything. Once a session crossed it
// the tripwire fired on *every* message for the rest of its life, and because
// it compared the counter before and after a compaction that genuinely does
// shrink the prompt, every call logged the same number -- ten no-ops in a row,
// `6070097 -> 6070097`, which reads like a broken compactor but was really a
// cumulative counter being compared against itself.
//
// Per-message usage is the only honest measure of prompt pressure, and it does
// fall when compaction works. The list is newest-first, and maybeCompact()
// runs from the caller's `finally` block after the reply has gone out, so
// these are completed turns.
async function contextPeak(sessionId) {
  const msgs = await oc(`/api/session/${sessionId}/message`, { timeoutMs: 15000 })
  if (!Array.isArray(msgs)) return 0
  let peak = 0
  for (const m of msgs.slice(0, CFG_.compactLookbackTurns ?? 4)) {
    const t = m.tokens || {}
    peak = Math.max(peak, (t.input || 0) + ((t.cache || {}).read || 0))
  }
  return peak
}

// Keep a session's context from growing without bound.
//
// This is a safety net, not the wedge fix. It runs after the reply is sent (see
// the `finally` in runTurn), so it can never add latency to an answer -- when
// it misfired it cost a wasted POST and a misleading log line, nothing more.
//
// It still earns its place. `POST /api/session/{id}/compact` cuts the prompt by
// ~95% while leaving every message readable, and OpenCode does not compact
// automatically on this path. Measured peak turn context for Lab sits around
// 60k against a 160k input ceiling, so the threshold is set at 120000: ~2x the
// observed baseline, ~75% of the real limit. Tune it against the "peak turn
// context" log line rather than guessing.
async function maybeCompact(sessionId) {
  if (!CFG_.compactAfterTokens) return
  const peak = await contextPeak(sessionId)
  if (peak < CFG_.compactAfterTokens) return
  log(`compacting ${sessionId}: peak turn context ${peak} exceeds ${CFG_.compactAfterTokens}`)
  await oc(`/api/session/${sessionId}/compact`, { method: "POST", body: "{}" })
  log(`compacted ${sessionId}: peak turn context ${peak} -> ${await contextPeak(sessionId)}`)
}

// ---------- incoming attachments ----------
// The bridge used to read msg.text only, so every file, photo and voice note was
// dropped silently -- Telegram would show the user a delivered message and the
// agent would never learn it existed.

// Never trust a client-supplied filename. Strip every directory component and
// anything that is not a plain filename character, so a crafted name such as
// "../../.ssh/authorized_keys" cannot escape the downloads directory.
function safeName(raw, fallback) {
  const base = String(raw || "").split(/[/\\]/).pop() || ""
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/^[.\s]+/, "")
    .trim()
  return (cleaned || fallback).slice(0, 100)
}

const fmtSize = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

function pickAttachment(msg) {
  if (msg.document)
    return { kind: "document", id: msg.document.file_id, name: msg.document.file_name, mime: msg.document.mime_type, size: msg.document.file_size }
  if (msg.photo?.length) {
    // Telegram sends photos as a size ladder; the last entry is the real one.
    const p = msg.photo[msg.photo.length - 1]
    return { kind: "photo", id: p.file_id, name: `photo_${p.file_unique_id}.jpg`, mime: "image/jpeg", size: p.file_size }
  }
  if (msg.voice)
    return { kind: "voice", id: msg.voice.file_id, name: `voice_${msg.voice.file_unique_id}.ogg`, mime: msg.voice.mime_type, size: msg.voice.file_size }
  if (msg.audio)
    return { kind: "audio", id: msg.audio.file_id, name: msg.audio.file_name || `audio_${msg.audio.file_unique_id}.mp3`, mime: msg.audio.mime_type, size: msg.audio.file_size }
  if (msg.video)
    return { kind: "video", id: msg.video.file_id, name: msg.video.file_name || `video_${msg.video.file_unique_id}.mp4`, mime: msg.video.mime_type, size: msg.video.file_size }
  if (msg.sticker)
    return { kind: "sticker", id: msg.sticker.file_id, name: `sticker_${msg.sticker.file_unique_id}.webp`, mime: "image/webp", size: msg.sticker.file_size }
  return null
}

// Whisper only reads uncompressed wav through its own miniaudio path, and
// miniaudio in this build has no Opus decoder -- which is exactly what Telegram
// voice notes are. So every audio file goes through ffmpeg to 16 kHz mono s16
// first. The same step is what makes video and webm attachments work.
async function transcribe(src) {
  if (!sttReady()) return { text: null, reason: "speech-to-text not configured" }

  const work = mkdtempSync(join(tmpdir(), "stt-"))
  const wav = join(work, "in.wav")
  try {
    await pexecFile(
      STT.ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", wav],
      { timeout: STT.maxMs },
    )

    const { stdout } = await pexecFile(
      STT.cli,
      // -nt drops timestamps, -np drops the non-speech banners, -l fixes the
      // language so short Arabic clips are not mis-detected as English.
      ["-m", STT.model, "-l", STT.lang, "-f", wav, "-nt", "-np"],
      {
        timeout: STT.maxMs,
        maxBuffer: 8 * 1024 * 1024,
        env: STT.libPath ? { ...process.env, LD_LIBRARY_PATH: STT.libPath } : process.env,
      },
    )

    const text = stdout.replace(/\s+/g, " ").trim()
    return { text: text || null, reason: text ? undefined : "no speech detected" }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function saveIncoming(chatId, att) {
  if (att.size && att.size > MAX_BYTES)
    throw new Error(`الملف كبير أوي (${fmtSize(att.size)}) والحد ${fmtSize(MAX_BYTES)}`)

  const info = await tg("getFile", { file_id: att.id }, 30000)
  if (!info?.file_path)
    throw new Error("تليجرام مش راجع مسار الملف — غالباً أكبر من ٢٠ ميجا أو البوت ماشي على حد التحميل")

  beat("downloading")
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`, {
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(`التحميل فشل: HTTP ${res.status}`)

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error(`الملف ${fmtSize(buf.length)} والحد ${fmtSize(MAX_BYTES)}`)

  mkdirSync(DL_DIR, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")
  const name = safeName(att.name, `${att.kind}_${stamp}`)
  const dest = join(DL_DIR, `${stamp}_${name}`)
  writeFileSync(dest, buf, { mode: 0o600 })
  log(`saved ${att.kind} from ${chatId}: ${dest} (${fmtSize(buf.length)})`)

  // The agent reads this block, so keep it structured and unambiguous.
  const lines = [
    "[incoming attachment from telegram]",
    `kind: ${att.kind}`,
    `original_name: ${att.name || "(none)"}`,
    `mime: ${att.mime || "unknown"}`,
    `saved_path: ${dest}`,
    `size: ${fmtSize(buf.length)}`,
  ]

  // Only speech and media carry meaning worth transcribing; a PDF is read
  // directly from disk instead.
  if (att.kind === "voice" || att.kind === "audio" || att.kind === "video") {
    beat("transcribing")
    try {
      const t0 = Date.now()
      const { text, reason } = await transcribe(dest)
      if (text) {
        lines.push(`transcript: ${text}`)
        lines.push(`(speech-to-text, ${((Date.now() - t0) / 1000).toFixed(1)}s — treat as imperfect, Egyptian Arabic)`)
      } else {
        lines.push(`transcript: (unavailable — ${reason})`)
      }
    } catch (err) {
      log(`transcribe failed for ${dest}:`, err.message)
      lines.push(`transcript: (failed — ${err.message.split("\n")[0]})`)
    }
  }

  return lines.join("\n")
}

// ---------- message handling ----------
async function handle(msg) {
  const chat = msg.chat
  if (!chat) return
  const text = msg.text || msg.caption || ""

  // Reply context: if this message quotes an earlier one, include the quoted
  // text so the agent sees what is being answered (Telegram sends it as
  // reply_to_message; the bridge previously dropped it entirely).
  let replyCtx = ""
  const rq = msg.reply_to_message
  if (rq) {
    const rtext = (rq.text || rq.caption || "").trim()
    const rfrom = rq.from?.is_bot ? "you (زلابية)" : (rq.from?.first_name || rq.from?.username || "Saif")
    if (rtext) {
      const clipped = rtext.length > 500 ? rtext.slice(0, 500) + "…" : rtext
      replyCtx = `[replying to ${rfrom}: "${clipped}"]\n`
    } else if (rq.photo || rq.document || rq.voice || rq.video || rq.audio) {
      replyCtx = `[replying to ${rfrom}'s attachment]\n`
    }
  }

  // /pair <code> from an unknown chat claims it.
  if (/^\/pair\b/.test(text)) {
    if (text.trim() === `/pair ${CFG_.pairingCode}`) {
      const id = String(chat.id)
      if (!state.allow.includes(id)) {
        state.allow.push(id)
        saveState()
        log(`paired chat ${id} (${chat.username || chat.first_name || "?"})`)
      }
      return send(chat.id, "✅ Paired. Send away.")
    }
    return send(chat.id, "❌ Wrong pairing code.")
  }

  // The allow check must run before any download. Doing it after would let any
  // stranger who knows the bot handle drop arbitrary bytes on this machine.
  if (!state.allow.includes(String(chat.id))) {
    log(`ignored message from unpaired chat ${chat.id} (${chat.username || "?"})`)
    // Tell them how to connect instead of silently ignoring them. A bot that
    // says nothing looks broken. The code itself is never revealed here —
    // only that one is required — so this cannot be used to brute-force in.
    if (!state.nudged?.includes(String(chat.id))) {
      state.nudged = [...(state.nudged || []), String(chat.id)]
      saveState()
      await send(
        chat.id,
        "👋 I'm not connected to anyone yet.\n\nSend `/pair <code>` to connect. " +
          "If someone gave you this bot's code, use it — otherwise you have the wrong code.",
      ).catch((e) => log(`nudge to ${chat.id} failed: ${e.message}`))
    }
    return
  }

  const busy = chat.id

  // Claim the chat slot SYNCHRONOUSLY, before the first await.
  //
  // The poll loop no longer awaits handle(), so several messages from one chat
  // are now genuinely in flight at once. If the busy-check and the set were
  // separated by an await (the attachment download below is one), two messages
  // could both observe "not busy" and each start a turn against the same
  // session -- concurrent prompts on one session, which corrupts ordering.
  const isNew = !running.has(busy)
  let q = running.get(busy)
  if (!q) {
    q = []
    running.set(busy, q)
  }

  // Attachments are fetched before the turn so the agent receives a real path
  // it can open, not a promise that a file exists somewhere.
  let incoming = replyCtx + text
  const att = pickAttachment(msg)
  if (att) {
    try {
      const notice = await saveIncoming(chat.id, att)
      incoming = replyCtx + (text.trim() ? `${text.trim()}\n\n${notice}` : notice)
    } catch (err) {
      log(`download failed from ${chat.id}:`, err.message)
      await send(chat.id, `⚠️ مقدرتش أنزّل الملف: ${err.message}`).catch(() => {})
      if (isNew) running.delete(busy)
      return
    }
  }
  if (!incoming.trim()) {
    if (isNew) running.delete(busy)
    return
  }

  if (!isNew) {
    // Preempt the running turn: a new message means the user wants an answer
    // NOW, not after the current job finishes. POST interrupt ends the model's
    // turn (the server exposes /api/session/{id}/interrupt -- the old "no
    // abort route" comment below is outdated for live sessions). Already-sent
    // tool calls stay done; the drain loop tells the agent to report partial
    // state and answer the new message first.
    const sid = state.sessions[String(busy)]
    if (sid) {
      oc(`/api/session/${sid}/interrupt`, { method: "POST", timeoutMs: 15000 })
        .then(() => log(`interrupted ${sid} for chat ${busy}`))
        .catch((e) => log(`interrupt failed for chat ${busy}: ${e.message}`))
    }
    interrupted.add(busy)
    q.unshift(incoming)
    log(`chat ${busy} busy, interrupted, ${q.length} message(s) queued (${incoming.length} chars)`)
    await send(chat.id, "Got it — stopping this, on yours now.").catch(() => {})
    return
  }
  q.push(incoming)

  // This message owns the slot, so it drains the queue.
  // `drainSid` remembers the last successful turn's session: after the slot is
  // released below, a DETACHED drainLate watches for background completions.
  // Detached is the point -- awaiting it here is what held the slot for 12 min
  // and made every follow-up look like an interruption (2026-10-11).
  let drainSid = null
  try {
    while (q.length) {
      const next = q.shift()
      if (!next?.trim()) continue
      try {
        const sessionId = await ensureSession(chat.id)
        // Identity bootstrap, applied once per session. Recovered-context and
        // bootstrap are mutually exclusive by construction: a rebuilt session
        // is new, so it gets the preamble AND the transcript excerpt, while a
        // continuing session gets neither.
        const key = String(chat.id)
        const needsBoot = state.needsBoot?.includes(key)
        // Memory goes LAST, immediately before the user's message, so it is the
        // freshest thing in context. Order matters: a rebuilt session prepends a
        // transcript excerpt that can run to tens of kilobytes, and anything
        // placed before that gets buried -- which would defeat the point of a
        // brain that is supposed to always be present.
        let outgoing = (needsBoot ? identityPreamble(sessionId) : "") + memoryPreamble(sessionId, { force: needsBoot, query: next }) + next
        if (interrupted.has(busy)) {
          // This message preempted a running turn. Report partial state in
          // one line (so the old work can resume later), then answer new.
          interrupted.delete(busy)
          outgoing =
            `=== Interrupted (read carefully) ===\n` +
            `The user interrupted your previous turn with a new message. ` +
            `First, in ONE line, state what you finished and what is left undone. ` +
            `Then answer the new message below. Do not continue the old work unless the new message asks for it.\n` +
            `=== end notice ===\n\n` + outgoing
        }
        if (needsBoot) {
          state.needsBoot = state.needsBoot.filter((k) => k !== key)
          saveState()
          log(`identity bootstrap applied to chat ${key}`)
        }
        const reply = await sendReply(chat.id, await runTurn(sessionId, outgoing, chat.id))
        appendHistory(chat.id, next, reply)
        drainSid = sessionId
      } catch (err) {
        if (err.code === "WEDGED") {
          // The session accepted prompts and produced nothing. There is no
          // abort route, so rebuild. Say so honestly: the replacement
          // INHERITS the tail below (recovered over the API + disk
          // transcript), it does not start blind. Never claim context is
          // lost -- that message itself is what taught the user to distrust
          // rebuilds (2026-10-06).
          log(`session ${err.reason || "wedged"} for chat ${busy}, rebuilding`)
          await send(
            chat.id,
            "♻️ That turn got stuck, so I'm rebuilding the session with our recent context. " +
              "One moment — retrying now.",
          ).catch(() => {})
          try {
            // Capture context from the dying session BEFORE dropping it. This
            // is the whole point: the replacement inherits what we were
            // doing, instead of greeting the user like a bot that has just
            // been switched on.
            const dead = state.sessions[String(busy)]
            const recovered = await recoverContext(chat.id, dead)
            delete state.sessions[String(busy)]
            saveState()
            const fresh = await ensureSession(chat.id)
            log(`new session ${fresh} for chat ${busy}, retrying once (recovered ${recovered.length} chars)`)
            // A rebuilt session is a new session, so it also needs the identity
            // preamble. ensureSession armed needsBoot for exactly this reason.
            const rkey = String(chat.id)
            const rboot = state.needsBoot?.includes(rkey)
            if (rboot) {
              state.needsBoot = state.needsBoot.filter((k) => k !== rkey)
              saveState()
            }
            const outgoing = (rboot ? identityPreamble(fresh) : "") + recovered + memoryPreamble(fresh, { force: true, query: next }) +
              `=== Retry notice (read carefully) ===\n` +
              `The previous turn accepted the user's message below but produced no reply (session wedged, now replaced). ` +
              `The recovered context above is history. Answer the CURRENT message below -- resolve ambiguous words like "it"/"do it" ` +
              `against the most recent assistant question in that history, not against older topics.\n` +
              `Current user message: ${next}\n` +
              `=== end retry notice ===\n\n` + next
            const reply = await sendReply(chat.id, await runTurn(fresh, outgoing, chat.id))
            appendHistory(chat.id, next, reply)
            drainSid = fresh
            continue
          } catch (retryErr) {
            log(`retry failed for chat ${busy}: ${retryErr.message}`)
            await send(chat.id, `⚠️ ${retryErr.message}`).catch(() => {})
            continue
          }
        }
        log(`error handling chat ${busy}:`, err.message)
        await send(chat.id, `⚠️ ${err.message}`).catch(() => {})
      }
    }
  } finally {
    // Drop the slot only if it is still ours. A message that arrived while the
    // final turn was in flight will have re-claimed it.
    if (running.get(busy) === q && !q.length) running.delete(busy)
  }
  // Slot is free: launch the late drain DETACHED. It stops itself the moment a
  // new turn starts (activeTurn guard inside), so follow-ups are answered
  // normally instead of treated as interruptions.
  if (drainSid) drainLate(drainSid, chat.id).catch((e) => log(`late drain failed: ${e.message}`))
}
const running = new Map()
// Chats with a turn currently inside runTurn (prompt sent, idle not yet seen).
// Lets the detached late drain know when to stop. Added 2026-10-11.
const activeTurn = new Set()
// Chats whose running turn was preempted by a newer message. Consumed once
// by the drain loop, which prepends an interrupt notice to the next prompt.
const interrupted = new Set()

// ---------- poll loop ----------
// Liveness beacon. A wedged-but-running bridge is indistinguishable from a
// healthy idle one by process state alone, and that silence is exactly how the
// bot went missing for 10.8h on 2026-09-27. Touched on every completed poll so
// the watchdog can tell "idle" from "wedged".
const HEARTBEAT_FILE = CFG_.heartbeatFile || `${STATE_FILE}.heartbeat`
function beat(stage) {
  try {
    writeFileSync(HEARTBEAT_FILE, `${Date.now()} ${stage}\n`)
  } catch (e) {
    // Never swallow this: the watchdog restarts the bridge on a stale
    // heartbeat, so a beacon that cannot be written turns into an endless
    // restart loop with nothing in the log to explain it.
    log(`WARNING: cannot write heartbeat ${HEARTBEAT_FILE}: ${e.message}`)
  }
}

async function main() {
  log(`starting; config=${CFG} opencode=${OC.baseUrl} allow=${JSON.stringify(state.allow)}`)
  // Report the brain at startup rather than waiting for the first message.
  // A bot that is running with no memory is otherwise indistinguishable from a
  // healthy one until someone notices it contradicting itself.
  const mem = loadMemory()
  log(
    mem.notice
      ? `memory BROKEN: ${CFG_.memoryFile} has no Core block -- repair notice will be injected`
      : mem.core
        ? `memory ok: ${CFG_.memoryFile} (${mem.core.length} bytes of Core)`
        : `memory MISSING: ${CFG_.memoryFile || "(no memoryFile configured)"}`,
  )
  // Observability (2026-10-13): localhost health server + HANDOFF prune at boot.
  try { startHealthServer() } catch (e) { log(`health server skipped: ${e.message}`) }
  try { pruneHandoffIfNeeded() } catch (e) { log(`handoff prune at boot skipped: ${e.message}`) }
  try {
    if (CFG_.memoryRecallEnable !== false && CFG_.workspaceDir) {
      const probe = recallMemory(CFG_.workspaceDir, "bridge wedge timeout memory recall probe", { topK: 1, maxChars: 200 })
      log(`recall ok: ${probe.length} hit(s) on boot probe`)
    } else {
      log("recall disabled or no workspaceDir — Core-only")
    }
  } catch (e) { log(`recall probe failed (Core-only): ${e.message}`) }
  let offset = state.offset

  // On first run (or after state loss) start from *now* rather than 0.
  // offset=0 would replay up to 24h of unconfirmed updates into the agent.
  if (offset === undefined) {
    const latest = await tg("getUpdates", { offset: -1, timeout: 0 }, 15000)
    offset = latest.length ? latest[latest.length - 1].update_id + 1 : 0
    state.offset = offset
    saveState()
    log(`first run: starting at offset ${offset} (skipped ${latest.length} pending update(s))`)
  }

  while (true) {
    try {
      const updates = await tg(
        "getUpdates",
        { offset, timeout: 25, allowed_updates: ["message"] },
        40000,
      )
      for (const u of updates) {
        offset = u.update_id + 1
        state.offset = offset
        if (u.message) {
          // Deliberately NOT awaited. Awaiting here blocks the long-poll for
          // the whole turn (54s to 11min measured), during which Telegram
          // buffers messages and then releases them as one batch the moment
          // polling resumes -- which is what "it only arrives after it times
          // out" looked like. Per-chat serialization lives in handle(), so
          // firing and forgetting preserves message order within a chat.
          handle(u.message).catch((e) => log(`handle failed: ${e.message}`))
        }
      }
      if (updates.length) saveState()
      beat("polling")
    } catch (err) {
      const d = String(err.message)
      // Beat before any early exit: an aborted long-poll is the most common
      // normal event in this loop, and skipping the beacon there would look
      // identical to a hang.
      beat("poll-error")
      if (d.includes("terminated") || d.includes("abort")) continue
      if (d.includes("409")) {
        log("409 Conflict — another process is polling this token. OpenClaw may still hold it.")
      } else {
        log("poll error:", d)
      }
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

for (const d of [HERE, join(HERE, "logs")]) if (!existsSync(d)) mkdirSync(d, { recursive: true })
main()
