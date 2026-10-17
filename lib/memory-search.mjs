#!/usr/bin/env node
// Memory recall for the Telegram bridge (upgrade #5).
// Dependency-free TF-IDF search over memory/topics/*.md + daily notes.
// Sync, fail-open: any error returns [] so the caller falls back to Core-only.
//
// Usage from bridge.mjs:
//   import { recallMemory } from "./lib/memory-search.mjs"
//   const hits = recallMemory(workspaceDir, queryText, { topK: 3, maxChars: 1500 })

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, basename } from "node:path"

const SECRET_LINE = /(?:bot\d{5,}:[A-Za-z0-9_-]{20,}|(?:[A-Za-z0-9]+[_.-])*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|private[_-]?key|credential)s?\s*[:=]\s*\S+|(?:^|[\s"'=])(sk|pk|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{16,}|\b[A-Fa-f0-9]{40,}\b)/i

function redactSecrets(text) {
  return String(text)
    .split("\n")
    .map((line) => (SECRET_LINE.test(line) ? line.replace(/(\S{4})\S*$/, "$1…[redacted]") : line))
    .join("\n")
}

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

function collectFiles(workspaceDir) {
  const files = []
  const memDir = join(workspaceDir, "memory")
  const topicsDir = join(memDir, "topics")
  try {
    if (existsSync(topicsDir)) {
      for (const f of readdirSync(topicsDir)) {
        if (f.endsWith(".md")) files.push(join(topicsDir, f))
      }
    }
  } catch { /* fail-open */ }
  try {
    if (existsSync(memDir)) {
      const entries = readdirSync(memDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
        .sort()
        .slice(-14) // last 14 daily notes only — bounds cost
      for (const f of entries) files.push(join(memDir, f))
    }
  } catch { /* fail-open */ }
  return files
}

function splitChunks(path, raw) {
  const chunks = []
  // Split on ## headings; content before the first heading becomes its own chunk.
  const parts = String(raw).split(/^##\s+/m)
  const first = parts[0].trim()
  if (first) chunks.push({ path, heading: basename(path), body: first.slice(0, 2000) })
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i]
    const nl = block.indexOf("\n")
    const heading = (nl >= 0 ? block.slice(0, nl) : block).trim().slice(0, 120) || basename(path)
    const body = (nl >= 0 ? block.slice(nl + 1) : "").trim().slice(0, 2000)
    if (body) chunks.push({ path, heading, body })
  }
  return chunks
}

export function recallMemory(workspaceDir, queryText, opts = {}) {
  try {
    if (!workspaceDir || !existsSync(workspaceDir)) return []
    const queryTokens = [...new Set(tokenize(queryText))]
    if (!queryTokens.length) return []
    const topK = opts.topK ?? 3
    const maxChars = opts.maxChars ?? 1500

    const files = collectFiles(workspaceDir)
    if (!files.length) return []

    let chunks = []
    for (const f of files) {
      try {
        const st = statSync(f)
        if (st.size > 65536) continue // skip pathological files
        chunks.push(...splitChunks(f, readFileSync(f, "utf8")))
      } catch { /* skip unreadable */ }
    }
    // Never recall from the Core brain file itself — it's already injected.
    chunks = chunks.filter((c) => basename(c.path) !== "MEMORY.md")
    if (!chunks.length) return []

    const N = chunks.length
    const chunkTokens = chunks.map((c) => tokenize(`${c.heading} ${c.body}`))
    const df = new Map()
    for (const toks of chunkTokens) {
      for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1)
    }
    const scored = []
    for (let i = 0; i < chunks.length; i++) {
      const toks = chunkTokens[i]
      if (!toks.length) continue
      const tf = new Map()
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
      let score = 0
      for (const q of queryTokens) {
        const f = tf.get(q) || 0
        if (!f) continue
        const idf = Math.log((N + 1) / ((df.get(q) || 0) + 1)) + 1
        score += (f / toks.length) * idf
      }
      // Small bonus for topic files over daily notes — topics are curated.
      if (chunks[i].path.includes("/topics/")) score *= 1.2
      if (score > 0) scored.push({ ...chunks[i], score })
    }
    scored.sort((a, b) => b.score - a.score)

    const out = []
    let used = 0
    for (const h of scored.slice(0, topK)) {
      const clean = redactSecrets(h.body).trim()
      if (!clean) continue
      const snippet = clean.length > 500 ? clean.slice(0, 500).trimEnd() + "…" : clean
      const line = `- ${h.heading}: ${snippet} (Source: ${h.path})`
      if (used + line.length > maxChars) break
      used += line.length
      out.push({ heading: h.heading, path: h.path, snippet, score: h.score })
    }
    return out
  } catch {
    return [] // fail-open: Core-only
  }
}

export function formatRecall(hits) {
  if (!hits?.length) return ""
  return (
    "=== RECALL (top matches from memory/topics + recent notes) ===\n" +
    hits.map((h) => `- ${h.heading}: ${h.snippet} (Source: ${h.path})`).join("\n") +
    "\n=== end RECALL ===\n\n"
  )
}
