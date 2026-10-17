# laapak-telegram-bridge

Telegram → OpenCode bridge for the Laapak bots (زلابية / hamada). Long-polls
the Telegram Bot API, maps each paired chat to a persistent OpenCode session,
and relays the agent's replies back — with durable memory injection, session
wedge recovery, attachments, and speech-to-text.

## Security (read first)

This repo is safe to make public — it contains **no credentials**. Before
running, create your own files outside the repo:

1. `telegram.token` — paste the bot token from @BotFather (`chmod 600`)
2. `server.env` — `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`
3. `bridge.json` — copy from `bridge.json.example` and fill in paths + a new
   random `pairingCode`

Never commit `telegram.token`, `server.env`, `bridge.json`, `state-*.json`,
`*.heartbeat`, `downloads/`, `logs/`, or `history/`.

## Quick start

```bash
git clone https://github.com/saifnasserer/laapak-telegram-bridge.git
cd laapak-telegram-bridge

echo '<BOT_TOKEN>' > telegram.token
chmod 600 telegram.token

cp bridge.json.example bridge.json
# edit bridge.json: tokenFile, stateFile, pairingCode, workspaceDir, etc.

node bridge.mjs bridge.json
```

Then send `/pair <your pairing code>` to the bot from your chat.

## Provision a new bot

```bash
./new-bot.sh <name> [port]
```

Creates an independent OpenCode server + bridge under `~/.openclaw-bots/<name>`
with systemd units. See `new-bot.sh` (kept out of this public repo; generate
locally).

## What the bridge does

- One OpenCode session per allowlisted chat, auto-recreated if a session wedges
- `MEMORY.md` Core block + `USER.md` preferences injected into every turn
- Context recovered from dead sessions (API + disk transcript fallback)
- Attachments saved to disk; voice/audio/video transcribed via Whisper
- `[sendfile:/path]` markers in replies deliver files back to the chat
- Per-turn JSONL logs + optional localhost `/healthz`
- Context compaction when per-turn prompt pressure crosses a threshold

See `BRIDGE.md` for the full reference: configuration, security model, wedge
handling, deployment, and file inventory.

## License

MIT — but this is an operational tool for a private bot; treat it as
"reference implementation" rather than a packaged product.
