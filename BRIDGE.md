# Laapak Telegram Bridge

A small, dependency-light Node.js bridge that connects a Telegram bot to an
OpenCode server, mapping each allowlisted chat to a persistent OpenCode session
and relaying the agent's replies back. One script, many independent bots — each
with its own token, workspace, identity, and memory.

This is the bridge behind **زلابية** (Zalabya), the Laapak Telegram bot, and the
second bot **hamada**, which shares the same `bridge.mjs`.

---

## What it does

- Long-polls the Telegram Bot API (`getUpdates`) and forwards each paired
  chat's messages to an OpenCode session via `POST /api/session/{id}/prompt`.
- Relays the agent's reply back to Telegram as HTML (bold, italic, code,
  links, fenced blocks), splitting long messages at 4096 chars.
- Maps each allowlisted chat ID to a durable OpenCode session id, recreated
  automatically if a session wedges.
- Injects the agent's durable memory (`MEMORY.md` Core block) + `USER.md`
  preferences into **every** turn, so continuity does not depend on the model
  or on session survival.
- Recovers context from a dead session (over the API, plus an on-disk
  transcript fallback) so a replacement session inherits what was in progress.
- Handles attachments (photos, documents, voice/audio/video): saves them to
  disk, transcribes voice/audio/video via Whisper, and injects a structured
  `[incoming attachment from telegram]` block the agent can read.
- Supports `[sendfile:/path]` markers in agent replies to ship files back to
  the chat.
- Per-chat serialization with interrupt + queue: a new message preempts a
  running turn and is answered first.
- Late drain: background completions that land after a turn ends are still
  forwarded.
- Automatic context compaction when per-turn prompt pressure crosses a
  threshold.
- Optional localhost health server (`/healthz`) and per-turn JSONL logs.
- Speech-to-text for voice notes (ffmpeg + whisper.cpp).

---

## Security — read before deploying

**Never commit real credentials.** The bridge reads secrets from files outside
the repo at runtime:

| Secret | Source | Never commit |
|--------|--------|--------------|
| Telegram bot token | `tokenFile` (e.g. `telegram.token`, filled from @BotFather) | `telegram.token`, `*.token` |
| OpenCode Basic Auth | `serverEnv` (e.g. `server.env`, `OPENCODE_SERVER_USERNAME/PASSWORD`) | `server.env`, `.env` |
| Pairing code | `bridge.json` `pairingCode` | the live `bridge.json` of a running bot |

The bridge also redacts lines that look like secrets (passwords, tokens, API
keys, long hex strings) from injected memory before they reach the prompt, so a
carelessly pasted token is not re-injected into every future turn.

Files that **must** stay out of a public repo: `telegram.token`, `*.token`,
`server.env`, `*.env`, live `bridge.json`, `state-*.json`, `*.heartbeat`,
`downloads/`, `logs/`, `history/`. See `.gitignore`.

---

## Configuration (`bridge.json`)

One config file per bot. Pass its path as the first argument to `bridge.mjs`;
default is `./bridge.json`.

### Required fields

| Field | Meaning |
|-------|---------|
| `name` | Log prefix for this bot (e.g. `"lab"`, `"hamada"`). |
| `tokenFile` | Path to a file containing only the Telegram bot token. |
| `stateFile` | Path to a JSON state file (sessions, allowlist, offset, needsBoot). |
| `pairingCode` | Code a chat sends as `/pair <code>` to claim the bot. |
| `opencode.baseUrl` | OpenCode server URL, e.g. `http://127.0.0.1:4097`. |
| `opencode.serverEnv` | Path to the env file with `OPENCODE_SERVER_USERNAME/PASSWORD`. |

### Optional fields (with defaults)

| Field | Default | Meaning |
|-------|---------|---------|
| `turnTimeoutMs` | 7,200,000 (2h) | Hard cap on a single turn. |
| `typingMaxMs` | 60% of turnTimeout | How long the typing bubble stays on. |
| `wedgeTimeoutMs` | 60,000 | Time-to-first-message before a session is declared wedged. |
| `stallTimeoutMs` | 240,000 | Silence-after-ack threshold. |
| `toolNoTimeoutMs` | 60,000 | Budget for tools that declare no timeout. |
| `toolGraceMs` | 30,000 | Slack added to a tool's declared timeout. |
| `generationGraceMs` | 600,000 | Patience when the model is generating (no tool running). |
| `progressAfterMs` | 150,000 | First "still working" status ping. |
| `progressEveryMs` | 180,000 | Repeat interval for progress pings. |
| `compactAfterTokens` | 120,000 | Per-turn prompt peak that triggers compaction. `0` disables. |
| `compactLookbackTurns` | 4 | How many recent turns to scan for peak context. |
| `workspaceDir` | `null` | Workspace holding `MEMORY.md`, `USER.md`, `memory/`. |
| `memoryFile` | derived from `workspaceDir` | Path to `MEMORY.md`. |
| `memoryCoreMaxBytes` | 4,000 | Core block size cap (truncated on a line boundary). |
| `memoryRecallEnable` | `true` | TF-IDF recall over `memory/topics/` + daily notes. |
| `memoryRecallTopK` | 3 | How many recall hits to inject. |
| `memoryRecallMaxChars` | 1,500 | Character budget for recall text. |
| `userFile` | derived from `workspaceDir` | Path to `USER.md`. |
| `downloadsDir` | `bridge/downloads/<name>/` | Where incoming attachments are saved. |
| `historyDir` | `bridge/history/<name>/` | On-disk transcript file per chat. |
| `historyMaxBytes` | 262,144 | Transcript file cap (trimmed from the front). |
| `recoverMsgs` / `recoverChars` | 24 / 12,000 | Context-recovery budget from dead sessions. |
| `logsDir` | `bridge/logs/<name>/` | Per-day JSONL turn logs. |
| `healthPort` | `0` (disabled) | Port for localhost-only `/healthz`. |
| `ffmpeg` / `whisperCli` / `whisperModel` / `whisperLibPath` | `""` | STT toolchain paths; empty disables transcription. |
| `whisperLanguage` | `"ar"` | Whisper language hint. |
| `whisperTimeoutMs` | 120,000 | Transcription timeout. |

### Example (`bridge.json.example`)

```json
{
  "name": "lab",
  "tokenFile": "/path/to/telegram.token",
  "stateFile": "/path/to/state-lab.json",
  "pairingCode": "CHANGE_ME_8CHARS",
  "turnTimeoutMs": 7200000,
  "opencode": {
    "baseUrl": "http://127.0.0.1:4097",
    "serverEnv": "/home/you/.config/opencode-web/server.env"
  },
  "workspaceDir": "/home/you/.openclaw-telegram",
  "memoryFile": "/home/you/.openclaw-telegram/MEMORY.md",
  "memoryCoreMaxBytes": 4000,
  "memoryRecallEnable": true,
  "memoryRecallTopK": 3,
  "memoryRecallMaxChars": 1500,
  "logsDir": "/home/you/.openclaw-telegram/bridge/logs/lab",
  "healthPort": 0
}
```

---

## How the bot is claimed (pairing)

An unpaired chat that messages the bot gets a nudge:

> 👋 I'm not connected to anyone yet. Send `/pair <code>` to connect.

The human sends `/pair <code>` where `<code>` is the bot's `pairingCode`.
The code itself is never revealed in the nudge, so this cannot be brute-forced.
Once paired, the chat id is added to `state.allow` and all further messages are
relayed to the agent.

---

## Memory & continuity

### MEMORY.md Core block (injected every turn)

The bridge reads one file, extracts the block between `<!-- CORE:BEGIN -->`
and `<!-- CORE:END -->`, and prepends it to every outgoing prompt. Properties:

1. **Read-only.** The bridge never writes `MEMORY.md`; the agent does.
2. **Cached by mtime/size.** Re-read only when the file changes; picked up on
   the next turn without a restart.
3. **Self-healing.** Missing markers → a repair notice is injected instead of
   silently running brainless, and it's logged loudly.

### USER.md (per-session delta)

Injected only when the file changed since the session last saw it, so standing
preferences stay fresh without re-sending the whole file every turn.

### Recall (memory v2, fail-open)

TF-IDF search over `memory/topics/*.md` + the last 14 daily notes, top 3 hits
appended after Core for the current query. Skipped when disabled or on error —
Core-only as before. `MEMORY.md` itself is never recalled from (it's already
injected).

---

## Session wedge handling (the core failure mode this bridge defends against)

A wedged session accepted prompts but produced nothing — Telegram would show
"typing..." for the whole turn timeout and then nothing. The bridge detects
this three ways and rebuilds:

1. **Tool hang:** a tool running past its declared (+grace) budget.
2. **Wedge:** prompt accepted (`acked`) but zero new messages within
   `wedgeTimeoutMs`.
3. **Stall:** messages flowing, then silence past `quietMs(fresh)` (which
   respects a running tool's own declared timeout so long builds aren't killed).

On detection, the bridge:
- Says honestly: *"That turn got stuck, so I'm rebuilding the session with our
  recent context. One moment — retrying now."*
- Recovers context from the dying session over the API (plus disk transcript
  fallback), then retries once in a fresh session with the identity preamble
  + recovered transcript + a retry notice telling the agent to answer the
  current message, not older topics.

The user's context is never claimed lost — the replacement inherits it.

---

## Attachments & speech-to-text

Incoming photos, documents, voice, audio, video, and stickers are saved to
`downloadsDir/<name>/` with sanitized filenames (20 MB cap, matching Telegram).
A structured block is injected:

```
[incoming attachment from telegram]
kind: photo
original_name: (none)
mime: image/jpeg
saved_path: /abs/path/to/file.jpg
size: 124 KB
```

Voice/audio/video are transcribed via ffmpeg → 16 kHz mono wav → whisper.cpp.
PDFs and images are read directly from disk by the agent (the bridge passes the
`saved_path`; pixels are never handed over).

---

## File delivery from the agent (`[sendfile]`)

An agent reply may carry one marker per line:

```
[sendfile:/absolute/path | ~/short/form | workspace/relative]
```

The marker is stripped from the text and the file is sent via
`sendDocument`. Only files under the workspace root or `/tmp/opencode` are
servable (max 20 MB). Anything else becomes a one-line error note instead of a
silent drop.

---

## Observability

- `log()` prints to stdout (captured by systemd/journalctl).
- `logTurn()` writes per-turn JSONL records to `logsDir/<name>-YYYY-MM-DD.jsonl`
  (outcome, duration, flags, tool calls, error).
- Optional localhost-only health server on `healthPort` serving `/healthz`
  (uptime, queue depth, active turns, last turn duration, p50/p95).
- Heartbeat file touched on every completed poll so a watchdog can distinguish
  "idle" from "wedged."

---

## Deployment

### systemd (per bot)

See `new-bot.sh` for the generated units:

- `opencode-<name>.service` — the OpenCode server instance (loopback only).
- `opencode-<name>-bridge.service` — the bridge, depends on the OpenCode unit.

Both restart always. The bridge is started after the token file is filled in.

### new-bot.sh

`./new-bot.sh <name> [port]` provisions a fully independent bot: its own
OpenCode server, identity workspace (`SOUL.md`, `AGENTS.md`, `DREAMS.md`,
`BOOTSTRAP.md`), token file (empty — fill from @BotFather), pairing code
(random 8 chars), config, and systemd units. Shares nothing mutable with other
bots.

---

## Running locally

```bash
# 1. Fill the token file (from @BotFather), chmod 600
echo '<BOT_TOKEN>' > telegram.token
chmod 600 telegram.token

# 2. Copy and edit the example config
cp bridge.json.example bridge.json
# edit bridge.json: set tokenFile, stateFile, pairingCode, workspaceDir, etc.

# 3. Run
node bridge.mjs bridge.json
```

---

## Files in this repo

| File | Purpose |
|------|---------|
| `bridge.mjs` | The bridge: polling, sessions, memory, attachments, wedge recovery. |
| `lib/memory-search.mjs` | Dependency-free TF-IDF recall over `memory/topics/` + daily notes. |
| `bridge.json.example` | Sanitized config template (copy to `bridge.json` and fill secrets). |
| `.gitignore` | Excludes tokens, state, logs, downloads, backups. |
| `BRIDGE.md` | This document. |
| `README.md` | Quick start + security checklist. |

---

## What is deliberately NOT in this repo

- `telegram.token` / any `*.token`
- `server.env` / any `*.env`
- Live `bridge.json` (contains pairing code + paths)
- `state-*.json` (sessions, allowlist, offset)
- `*.heartbeat`
- `downloads/`, `logs/`, `history/` (user data)
- `bridge.mjs.bak.*` (local working backups)
