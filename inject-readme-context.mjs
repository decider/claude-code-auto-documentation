#!/usr/bin/env node
/**
 * docgen — README-context injection hook for Claude Code.
 *
 * Registered as a PreToolUse hook in .claude/settings.json. Fires before
 * Read / Edit / Grep / Glob tool calls. Walks from the tool's target
 * path UP the directory tree, finds each ancestor's README.md, and
 * prints the contents to stdout — Claude Code's hook contract treats
 * hook stdout as additional context fed to the next LLM turn.
 *
 * The result: when the agent is about to read `bots/src/server/
 * paper-prices.ts`, it transparently gets:
 *   - bots/README.md                     (subsystem-level prose)
 *   - bots/src/README.md                 (mid-level)
 *   - bots/src/server/README.md          (file-level index)
 *
 * Without ever having to think "let me also check the README". The
 * per-directory READMEs become load-bearing context instead of
 * shelfware.
 *
 * The hook itself NEVER throws — Claude Code treats non-zero exits as
 * "block this tool call" and we never want to block. On any error we
 * print nothing and exit 0.
 *
 * Contract with Claude Code (https://docs.claude.com/en/docs/claude-code/hooks):
 *   - stdin:  JSON `{ "tool_name": "...", "tool_input": {...} }`
 *   - stdout: extra context appended to the LLM's next view
 *   - exit 0 = ok; non-zero = block (we never block)
 */

import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Short content fingerprint for dedup. Two READMEs with byte-identical
 *  content hash to the same key — so we never re-inject the same content
 *  twice in a session, even when it lives at different absolute paths
 *  (e.g. multiple worktrees of the same repo open in one Claude Code
 *  session). 16 hex chars of sha1 is ample collision resistance for the
 *  ~dozens of READMEs in a session. */
function contentHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// ─── config ───────────────────────────────────────────────────────────────

/** Tools whose tool_input contains a file_path / pattern we can locate
 *  in the tree. Other tools (TaskCreate, Bash with no path, …) just fall
 *  through and the hook emits nothing. */
const TOOLS_WITH_PATHS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep']);

/** Don't bother injecting context if the target file IS itself a
 *  README — avoid infinite re-entry of the same content. */
const NOOP_BASENAMES = new Set(['README.md', 'CLAUDE.md']);

/** Max ancestor depth to walk before stopping. Plenty for typical
 *  repos; this caps token cost on deeply-nested touches. */
const MAX_ANCESTORS = 6;

/** Per-README byte cap. Most generated READMEs are ~2-3 KB; this is
 *  the safety net for a long hand-written one. */
const MAX_README_BYTES = 6 * 1024;

/**
 * Deduplicate within a single Claude session: a session-scoped cache
 * file at /tmp/docgen-injected-<session_id>.json tracks which READMEs
 * have already been injected so we don't re-emit the same content on
 * every Read in the same directory. Each entry stores the README path;
 * subsequent calls in the same session skip it.
 *
 * We key on session_id from the hook payload; if absent, we use the
 * parent process's CLAUDE_SESSION_ID env (best-effort).
 */
const DEDUP_DIR = '/tmp';
function dedupPath(sessionId) {
  const safe = (sessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_');
  return join(DEDUP_DIR, `docgen-injected-${safe}.json`);
}

// ─── stdin payload ────────────────────────────────────────────────────────

function readStdinSync() {
  // Block until EOF — Claude Code closes stdin after writing the JSON.
  // Using readFileSync(0) reads from fd 0 (stdin) to EOF.
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function extractTargetPath(payload) {
  const tool = payload?.tool_name;
  if (!tool || !TOOLS_WITH_PATHS.has(tool)) return null;
  const input = payload?.tool_input || {};
  // Read / Edit / Write — direct file_path.
  if (typeof input.file_path === 'string' && input.file_path.length) {
    return input.file_path;
  }
  // Glob — pattern + optional path. Use the path if given; else try to
  // extract the directory part of the pattern.
  if (tool === 'Glob') {
    if (typeof input.path === 'string' && input.path.length) return input.path;
    if (typeof input.pattern === 'string') {
      // Strip glob wildcards from the end to find an anchor dir.
      const stripped = input.pattern.replace(/(\/?\*+.*)$/, '');
      return stripped || null;
    }
  }
  // Grep — same idea.
  if (tool === 'Grep') {
    if (typeof input.path === 'string' && input.path.length) return input.path;
  }
  return null;
}

// ─── repo root + ancestor walking ────────────────────────────────────────

function repoRoot(startDir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Yield each ancestor directory of `start`, FROM the leaf upward, up
 *  to and including `root`. */
function* ancestorsUpTo(start, root) {
  let dir = start;
  let count = 0;
  while (count < MAX_ANCESTORS) {
    yield dir;
    if (dir === root) return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
    count += 1;
  }
}

/** Read a README's docgen marker / version, if present. Pure
 *  information — we DON'T filter by marker; hand-written READMEs are
 *  equally valuable for context. */
function readmeMeta(text) {
  const m = text.match(/<!--\s*docgen:version=(\d+\.\d+\.\d+)(?:\s+reason:\s*([^>]*?))?\s*-->/);
  if (m) return { kind: 'generated', version: m[1], reason: (m[2] ?? '').trim() };
  // Anything else = hand-written; still load it.
  return { kind: 'hand-written', version: null, reason: null };
}

/** Pull just the `## Purpose` section body — used for ANCESTOR directory
 *  READMEs, where we want one-line "what is this layer" orientation, not
 *  the whole Map / file list. Falls back to the post-marker head. */
function extractPurpose(text) {
  const m = text.match(/^##\s+Purpose\s*\r?\n([\s\S]*?)(?=\r?\n##\s|\s*$)/m);
  if (m && m[1].trim()) return m[1].trim();
  const body = text.replace(/^<!--[\s\S]*?-->\s*/g, '').trim();
  return body.length > 500 ? body.slice(0, 500) + '…' : body;
}

// ─── dedup IO ─────────────────────────────────────────────────────────────

function loadDedup(sessionId) {
  const p = dedupPath(sessionId);
  if (!existsSync(p)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(p, 'utf8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveDedup(sessionId, set) {
  const p = dedupPath(sessionId);
  try {
    // Best-effort write — never throw out of the hook.
    writeFileSync(p, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

// ─── main ─────────────────────────────────────────────────────────────────

function main() {
  const raw = readStdinSync();
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return; // bad payload — emit nothing
  }

  const targetRaw = extractTargetPath(payload);
  if (!targetRaw) return;

  // If the target IS a README, the agent is about to read its content
  // directly — record it as "already in context" so a SUBSEQUENT tool
  // call on a sibling file in the same dir doesn't re-inject the same
  // README. Then return — no injection on README reads.
  const targetAbs = isAbsolute(targetRaw) ? targetRaw : resolve(targetRaw);
  const basename = targetAbs.split('/').pop() || '';
  if (NOOP_BASENAMES.has(basename)) {
    const sessionIdForReadme =
      payload?.session_id ?? process.env.CLAUDE_SESSION_ID;
    if (sessionIdForReadme) {
      try {
        // Mark this README as "seen this session" so any later ancestor walk
        // doesn't re-inject any slice of it. Key on the FULL text so it
        // matches whichever slice the inject loop would have chosen.
        const text = readFileSync(targetAbs, 'utf8');
        const key = contentHash(text);
        const dedup = loadDedup(sessionIdForReadme);
        if (!dedup.has(key)) {
          dedup.add(key);
          saveDedup(sessionIdForReadme, dedup);
        }
      } catch { /* dedup is best-effort */ }
    }
    return;
  }

  // Determine the START directory: the target file's parent if the
  // target is a file (or maybe a future file), else the target itself
  // if it's already a dir.
  let startDir;
  try {
    const st = existsSync(targetAbs) ? statSync(targetAbs) : null;
    startDir = st && st.isDirectory() ? targetAbs : dirname(targetAbs);
  } catch {
    startDir = dirname(targetAbs);
  }

  // Anchor at the enclosing git repo root; outside any repo, give up.
  const root = repoRoot(startDir);
  if (!root) return;

  // Canonicalise so /tmp vs /private/tmp doesn't break ancestor checks.
  let canonicalStart;
  try {
    canonicalStart = realpathSync(startDir);
  } catch {
    canonicalStart = startDir;
  }
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    canonicalRoot = root;
  }

  // Walk leaf → root, gathering READMEs that we haven't already
  // injected this session.
  const sessionId = payload?.session_id ?? process.env.CLAUDE_SESSION_ID;
  const dedup = loadDedup(sessionId);

  const collected = [];
  // Tiered injection: the NEAREST directory (the file's own dir) gets the
  // FULL README map + full CLAUDE.md — that's the layer you're editing.
  // Ancestors contribute only their README ## Purpose line (orientation),
  // but their hand-written CLAUDE.md is kept in full (rules/nuance the
  // author wants seen at every depth). Keeps a deep chain lean while never
  // crowding out the relevant map.
  const cap = (text) =>
    text.length > MAX_README_BYTES ? text.slice(0, MAX_README_BYTES) + '\n…(truncated)' : text;
  let isClosest = true;
  for (const dir of ancestorsUpTo(canonicalStart, canonicalRoot)) {
    // Two surfaces per directory:
    //   README.md  — auto-generated by docgen, the dir's Map / file index
    //   CLAUDE.md  — hand-written sidecar (rules / gotchas / nuance docgen
    //                can't infer). docgen NEVER touches CLAUDE.md, so it's
    //                durable across regenerations. Both get injected.
    let dirHadDoc = false;
    for (const basename of ['README.md', 'CLAUDE.md']) {
      const docPath = join(dir, basename);
      // Root CLAUDE.md is redundant — Claude Code auto-loads the repo-root
      // CLAUDE.md natively, and it's large (would eat the additionalContext
      // budget and truncate the nearer Map). Inject only SUB-dir CLAUDE.md
      // sidecars (which CC does NOT load).
      if (basename === 'CLAUDE.md' && dir === canonicalRoot) continue;
      if (!existsSync(docPath)) continue;
      let text;
      try {
        text = readFileSync(docPath, 'utf8');
      } catch {
        continue;
      }
      // CONTENT-HASH dedup keyed on the FULL README text (not the slice we
      // happen to inject this call): "this README has been shown to Claude
      // this session" — whether previously as a leaf-full Map or as an
      // ancestor Purpose, don't re-emit any slice of it. This also collapses
      // sibling worktrees with byte-identical READMEs to a single injection,
      // fixing the path-keyed dedup bug where the same content was injected
      // 2–3× in one session.
      const key = contentHash(text);
      if (dedup.has(key)) continue;
      const meta = readmeMeta(text);
      let content;
      if (isClosest || basename === 'CLAUDE.md') {
        content = cap(text);
      } else {
        content = extractPurpose(text);
      }
      collected.push({
        relPath: relative(canonicalRoot, docPath),
        meta,
        content,
      });
      dedup.add(key);
      dirHadDoc = true;
    }
    if (dirHadDoc) isClosest = false;
  }

  if (collected.length === 0) return;

  const targetRel = relative(canonicalRoot, targetAbs) || targetAbs;

  // Trace: log WHICH docs were injected (full ancestor chain), not just the
  // count, so a verification pass can confirm the walk. DOCGEN_HOOK_TRACE=0 off.
  if (process.env.DOCGEN_HOOK_TRACE !== '0') {
    try {
      const paths = collected.map((c) => c.relPath).join(', ');
      const traceLine = `${new Date().toISOString()} session=${sessionId ?? '?'} target=${targetRel} injected=${collected.length} [${paths}]\n`;
      writeFileSync('/tmp/docgen-hook-trace.log', traceLine, { flag: 'a' });
    } catch { /* trace is best-effort */ }
  }

  // Root-most first so the LLM reads broad → narrow.
  collected.reverse();

  const lines = [];
  lines.push(
    `[docgen:context] You're about to access \`${targetRel}\`. Injected below: the ` +
      `FULL map for the file's own directory + a one-line Purpose for each ancestor ` +
      `directory's README, plus any hand-written CLAUDE.md sidecars (durable ` +
      `rules/nuance). Auto-injected (progressive disclosure), ordered repo-root → ` +
      `the file's own dir. The map is a jump-table (concept → file · symbol); grep ` +
      `a symbol to dive in. No need to re-Read these.`,
  );
  lines.push('');
  for (const c of collected) {
    const isClaude = c.relPath.endsWith('CLAUDE.md');
    const prov = isClaude
      ? 'hand-written CLAUDE.md sidecar'
      : c.meta.kind === 'generated'
        ? `docgen-generated v${c.meta.version}${c.meta.reason ? ` — ${c.meta.reason}` : ''}`
        : 'hand-written';
    lines.push(`### ${c.relPath}  (${prov})`);
    lines.push('');
    lines.push(c.content.trim());
    lines.push('');
  }

  // CRITICAL: a PreToolUse hook's plain stdout goes to the user transcript,
  // NOT the model. The only path into Claude's context is the JSON
  // hookSpecificOutput.additionalContext field (capped ~10k chars).
  const MAX_CONTEXT_CHARS = 10000;
  let contextText = lines.join('\n');
  if (contextText.length > MAX_CONTEXT_CHARS) {
    contextText = contextText.slice(0, MAX_CONTEXT_CHARS) + '\n…(injected context truncated to fit the 10k limit)';
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: contextText,
      },
    }),
  );

  saveDedup(sessionId, dedup);
}

try {
  main();
} catch {
  // Hooks must never throw — silently exit 0 on any unexpected error.
}
