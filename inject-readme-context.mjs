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

// ─── config ───────────────────────────────────────────────────────────────

/** Tools whose tool_input contains a file_path / pattern we can locate
 *  in the tree. Other tools (TaskCreate, Bash with no path, …) just fall
 *  through and the hook emits nothing. */
const TOOLS_WITH_PATHS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep']);

/** Don't bother injecting context if the target file IS itself a
 *  README — avoid infinite re-entry of the same content. */
const NOOP_BASENAMES = new Set(['README.md']);

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
        // Canonicalise so /tmp vs /private/tmp doesn't break later
        // ancestor-chain comparisons.
        const canonicalReadme = (() => {
          try {
            return realpathSync(targetAbs);
          } catch {
            return targetAbs;
          }
        })();
        const dedup = loadDedup(sessionIdForReadme);
        if (!dedup.has(canonicalReadme)) {
          dedup.add(canonicalReadme);
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
  for (const dir of ancestorsUpTo(canonicalStart, canonicalRoot)) {
    const readmePath = join(dir, 'README.md');
    if (!existsSync(readmePath)) continue;
    if (dedup.has(readmePath)) continue;
    let text;
    try {
      text = readFileSync(readmePath, 'utf8');
    } catch {
      continue;
    }
    const meta = readmeMeta(text);
    const trimmed = text.length > MAX_README_BYTES
      ? text.slice(0, MAX_README_BYTES) + '\n…(truncated)'
      : text;
    collected.push({
      relPath: relative(canonicalRoot, readmePath),
      meta,
      content: trimmed,
    });
    dedup.add(readmePath);
  }

  if (collected.length === 0) return;

  // Best-effort debug trace so we can verify the hook actually fires in
  // a real Claude Code run (`stream-json` doesn't surface hook stdout
  // as a separate event). Disabled when DOCGEN_HOOK_TRACE=0.
  if (process.env.DOCGEN_HOOK_TRACE !== '0') {
    try {
      const traceLine = `${new Date().toISOString()} session=${sessionId ?? '?'} target=${relative(canonicalRoot, targetAbs) || targetAbs} injected=${collected.length}\n`;
      writeFileSync('/tmp/docgen-hook-trace.log', traceLine, { flag: 'a' });
    } catch { /* trace is best-effort */ }
  }

  // Print one combined context block. Order: root-most first so the
  // LLM reads broadest-context to narrowest, matching the pyramid.
  collected.reverse();

  const lines = [];
  lines.push(
    `[docgen] Auto-injected ${collected.length} README(s) for ` +
      `${relative(canonicalRoot, targetAbs) || targetAbs}. ` +
      `These describe the directory tree above the file you're about to touch — ` +
      `use them as orientation; you don't need to re-Read them.`,
  );
  lines.push('');
  for (const c of collected) {
    lines.push(`### ${c.relPath} (${c.meta.kind}${c.meta.version ? `, v${c.meta.version}` : ''})`);
    lines.push('');
    lines.push(c.content.trim());
    lines.push('');
  }
  process.stdout.write(lines.join('\n') + '\n');

  saveDedup(sessionId, dedup);
}

try {
  main();
} catch {
  // Hooks must never throw — silently exit 0 on any unexpected error.
}
