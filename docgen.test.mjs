/**
 * Tests for tools/docgen/docgen.mjs.
 *
 * Run with:  node --test tools/docgen/docgen.test.mjs
 *
 * Hermetic: every test builds a fresh tmp repo, exercises docgen via
 * its exported helpers, and asserts on filesystem state. No real
 * `claude -p` is spawned — `analyzeOne` accepts a mock runner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  loadState,
  saveState,
  walkDirs,
  walkDirsBottomUp,
  selectFiles,
  needsAnalysis,
  assembleContext,
  analyzeOne,
  analyzeAllParallel,
  computeStatus,
  parseVersion,
  bumpType,
  resolveVersion,
  findChildReadmesInState,
  isHandWrittenReadme,
} from './docgen.mjs';

// ─── tmp-repo helpers ─────────────────────────────────────────────────────

function freshRepo() {
  const root = mkdtempSync(join(tmpdir(), 'docgen-'));
  return root;
}

function file(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function setMtime(path, msAgo) {
  const t = (Date.now() - msAgo) / 1000;
  utimesSync(path, t, t);
}

const PROMPT = 'Write a README. (test prompt)';

// ─── walking ──────────────────────────────────────────────────────────────

test('walkDirs yields content-bearing dirs and skips node_modules / hidden / dist', () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'export const a = 1;');
    file(root, 'src/sub/b.ts', 'export const b = 2;');
    file(root, 'node_modules/foo/package.json', '{}');
    file(root, '.git/HEAD', 'ref: ...');
    file(root, 'dist/bundle.js', 'minified');
    file(root, '.hidden/x.txt', 'no');
    file(root, 'tools/docgen/docgen.mjs', '// no');

    const dirs = [...walkDirs(root)].map((d) => d.replace(root + '/', ''));
    assert.ok(dirs.includes('src'), 'src should be included');
    assert.ok(dirs.includes('src/sub'), 'src/sub should be included');
    assert.ok(dirs.includes('tools/docgen'), 'tools/docgen should be included');
    for (const skipped of ['node_modules', '.git', 'dist', '.hidden']) {
      assert.ok(
        !dirs.some((d) => d.startsWith(skipped)),
        `${skipped} should NOT appear, got: ${dirs.filter((d) => d.startsWith(skipped))}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── file selection ───────────────────────────────────────────────────────

test('selectFiles skips README.md, binaries, dotfiles', () => {
  const root = freshRepo();
  try {
    file(root, 'pkg/index.ts', 'export const x = 1;');
    file(root, 'pkg/README.md', '# old hand-written');
    file(root, 'pkg/icon.png', 'binary');
    file(root, 'pkg/.env', 'SECRET=1');
    file(root, 'pkg/notes.md', 'some notes');

    const files = selectFiles(join(root, 'pkg')).map((f) => f.name);
    assert.ok(files.includes('index.ts'));
    assert.ok(files.includes('notes.md'));
    assert.ok(!files.includes('README.md'), 'README.md must be skipped');
    assert.ok(!files.includes('icon.png'), '.png must be skipped');
    assert.ok(!files.includes('.env'), 'dotfiles must be skipped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── staleness logic ──────────────────────────────────────────────────────

test('needsAnalysis: never-analyzed for an unseen dir', () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');
    const state = loadState(root);
    assert.equal(needsAnalysis(root, join(root, 'src'), state), 'never-analyzed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: null when file mtimes match state', () => {
  const root = freshRepo();
  try {
    const f = file(root, 'src/a.ts', 'a');
    const dir = join(root, 'src');
    const files = selectFiles(dir);
    const state = {
      version: 1,
      lastRun: null,
      directories: {
        src: {
          lastAnalyzed: new Date().toISOString(),
          files: Object.fromEntries(files.map((x) => [x.name, Math.floor(x.mtimeMs)])),
        },
      },
    };
    assert.equal(needsAnalysis(root, dir, state), null, 'fresh dir should return null');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: file-modified when a file mtime changes', () => {
  const root = freshRepo();
  try {
    const f = file(root, 'src/a.ts', 'a');
    const dir = join(root, 'src');
    const files = selectFiles(dir);
    const state = {
      version: 1,
      lastRun: null,
      directories: {
        src: {
          lastAnalyzed: new Date().toISOString(),
          files: Object.fromEntries(files.map((x) => [x.name, Math.floor(x.mtimeMs)])),
        },
      },
    };
    // Bump mtime forward.
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(f, future, future);
    assert.equal(needsAnalysis(root, dir, state), 'file-modified');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: file-set-changed when a new file appears', () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');
    const dir = join(root, 'src');
    const filesBefore = selectFiles(dir);
    const state = {
      version: 1,
      lastRun: null,
      directories: {
        src: {
          lastAnalyzed: new Date().toISOString(),
          files: Object.fromEntries(filesBefore.map((x) => [x.name, Math.floor(x.mtimeMs)])),
        },
      },
    };
    file(root, 'src/b.ts', 'b');
    assert.equal(needsAnalysis(root, dir, state), 'file-set-changed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── analyzeOne (the load-bearing one) ────────────────────────────────────

test('analyzeOne writes README.md with marker + updates state', async () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'export const a = 1;');
    file(root, 'src/b.ts', 'export const b = 2;');

    const runnerCalls = [];
    const mockRunner = async ({ prompt, context }) => {
      runnerCalls.push({ promptLen: prompt.length, contextLen: context.length });
      return '## Purpose\n\nFake src directory.\n\n## Files\n- `a.ts` — first.\n- `b.ts` — second.\n';
    };

    const res = await analyzeOne(root, {
      runner: mockRunner,
      promptText: PROMPT,
    });

    assert.equal(res.picked, 'src');
    assert.equal(res.reason, 'never-analyzed');
    assert.equal(res.fileCount, 2);
    assert.equal(runnerCalls.length, 1, 'runner should be invoked once');

    const readme = readFileSync(join(root, 'src', 'README.md'), 'utf8');
    assert.ok(readme.startsWith('<!-- auto-generated by docgen'), 'README must carry the marker');
    assert.ok(readme.includes('Fake src directory'), 'README must contain runner output');

    const state = loadState(root);
    assert.ok(state.directories.src, 'state must record the analyzed dir');
    assert.equal(Object.keys(state.directories.src.files).length, 2);
    assert.ok(state.lastRun, 'lastRun must be set');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeOne strips outer ```markdown fence if Claude wraps the response', async () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'export const a = 1;');
    const mockRunner = async () =>
      '```markdown\n## Purpose\n\nFenced response.\n```\n';

    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT });

    const readme = readFileSync(join(root, 'src', 'README.md'), 'utf8');
    assert.ok(readme.includes('Fenced response'), 'fenced content must be preserved');
    // The outer fence must NOT survive — we should see the inner Purpose
    // header directly after the marker.
    assert.ok(!readme.includes('```markdown'), 'outer markdown fence must be stripped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeOne picks NOTHING after both leaf AND its trunk are documented', async () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');
    let callCount = 0;
    const mockRunner = async () => {
      callCount += 1;
      return '<!-- docgen:version=0.1.0 reason: initial -->\n\n## Purpose\n\nDone.';
    };
    // 1: leaf src/ analysed (deepest first).
    const r1 = await analyzeOne(root, { runner: mockRunner, promptText: PROMPT });
    assert.equal(r1.picked, 'src');
    // 2: root `.` now needs analysis — it's a trunk with src/ as a child.
    const r2 = await analyzeOne(root, { runner: mockRunner, promptText: PROMPT });
    assert.equal(r2.picked, '.', 'root must be picked as the trunk now that src has a README');
    // 3: everything documented and fresh.
    const r3 = await analyzeOne(root, { runner: mockRunner, promptText: PROMPT });
    assert.equal(r3.picked, null);
    assert.equal(callCount, 2, 'runner runs once per leaf + once per trunk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeOne dry-run returns metadata without calling runner or writing files', async () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');
    let called = false;
    const mockRunner = async () => {
      called = true;
      return 'should not fire';
    };
    const res = await analyzeOne(root, {
      runner: mockRunner,
      promptText: PROMPT,
      dryRun: true,
    });
    assert.equal(res.picked, 'src');
    assert.equal(res.dryRun, true);
    assert.equal(called, false, 'runner must NOT be invoked on dry-run');
    assert.equal(existsSync(join(root, 'src', 'README.md')), false, 'no README on dry-run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── status / coverage ────────────────────────────────────────────────────

test('computeStatus reports documented / stale / uncovered correctly', async () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');
    file(root, 'lib/b.ts', 'b');
    file(root, 'other/c.ts', 'c');

    // Analyze src and lib; leave other uncovered.
    const mockRunner = async () => '## Purpose\n\nDone.';
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'src') });
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'lib') });

    // Stale-out src by mtime-bumping its file.
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(join(root, 'src', 'a.ts'), future, future);

    const s = computeStatus(root);
    // 4 total: src, lib, other, and `.` (root is a trunk).
    assert.equal(s.total, 4);
    assert.equal(s.uncovered, 2, '`other` and `.` (trunk) should be uncovered');
    assert.equal(s.stale, 1, '`src` should be stale (mtime bumped)');
    assert.equal(s.documented, 1, '`lib` should be the only fresh one');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── context assembly ─────────────────────────────────────────────────────

test('assembleContext truncates files larger than the per-file cap', () => {
  const root = freshRepo();
  try {
    const big = 'x'.repeat(20 * 1024); // 20 KB — over the 8 KB cap
    file(root, 'src/big.ts', big);
    const files = selectFiles(join(root, 'src'));
    const ctx = assembleContext(root, join(root, 'src'), files);
    assert.ok(ctx.includes('big.ts (truncated)'), 'header must mark truncation');
    // Body should be capped — far less than the 20 KB original.
    assert.ok(ctx.length < 15 * 1024, 'context should be substantially smaller than full file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── state persistence ───────────────────────────────────────────────────

// ─── version parsing + bump logic ─────────────────────────────────────────

test('parseVersion extracts X.Y.Z and reason from the HTML comment', () => {
  const v = parseVersion('<!-- docgen:version=0.3.1 reason: added X -->\n\n## Purpose');
  assert.equal(v.version, '0.3.1');
  assert.equal(v.reason, 'added X');
});

test('parseVersion returns null when no marker present', () => {
  assert.equal(parseVersion('no marker here'), null);
  assert.equal(parseVersion(''), null);
});

test('bumpType classifies transitions correctly', () => {
  assert.equal(bumpType(null, '0.1.0'), 'initial');
  assert.equal(bumpType('0.1.0', '0.1.0'), 'same');
  assert.equal(bumpType('0.1.0', '0.1.1'), 'patch');
  assert.equal(bumpType('0.1.5', '0.2.0'), 'minor');
  assert.equal(bumpType('0.1.0', '1.0.0'), 'major');
});

test('resolveVersion: no prior → accept LLM version (default 0.1.0)', () => {
  assert.equal(resolveVersion(null, '0.5.0', false), '0.5.0');
  assert.equal(resolveVersion(null, null, false), '0.1.0');
});

test('resolveVersion: LLM omitted → patch bump from prior', () => {
  assert.equal(resolveVersion('0.3.1', null, false), '0.3.2');
});

test('resolveVersion: LLM patch + file-set changed → ESCALATE to minor', () => {
  assert.equal(
    resolveVersion('0.3.1', '0.3.2', true),
    '0.4.0',
    'file-set change must force minor even if LLM picked patch',
  );
});

test('resolveVersion: LLM minor + file-set changed → honour LLM (already minor+)', () => {
  assert.equal(resolveVersion('0.3.1', '0.4.0', true), '0.4.0');
});

test('resolveVersion: LLM patch + no file-set change → honour LLM (truly cosmetic)', () => {
  assert.equal(resolveVersion('0.3.1', '0.3.2', false), '0.3.2');
});

// ─── bottom-up walk order ────────────────────────────────────────────────

test('walkDirsBottomUp yields deepest dirs first', () => {
  const root = freshRepo();
  try {
    file(root, 'a/b/c/leaf.ts', 'leaf');
    file(root, 'a/sibling.ts', 'sibling');
    const order = walkDirsBottomUp(root).map((d) => d.replace(root + '/', '').replace(root, '.'));
    // Find indices.
    const depth3 = order.findIndex((d) => d === 'a/b/c');
    const depth2 = order.findIndex((d) => d === 'a/b');
    const depth1 = order.findIndex((d) => d === 'a');
    assert.ok(depth3 < depth2, 'depth-3 must come before depth-2');
    assert.ok(depth2 < depth1, 'depth-2 must come before depth-1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── child-version-triggered bubble-up ────────────────────────────────────

test('cascade is MAJOR-only: a child minor bump does NOT propagate, a major bump does', async () => {
  const root = freshRepo();
  try {
    file(root, 'pkg/leaf/a.ts', 'a');
    file(root, 'pkg/other.ts', 'o');

    let v = 0;
    const mockRunner = async () => {
      v++;
      // 1: leaf 0.1.0  2: trunk pkg/ 0.1.0 (records leaf@0.1.0)
      // 3: leaf 0.2.0 (MINOR bump)  4: leaf 1.0.0 (MAJOR bump)
      const versions = ['0.1.0', '0.1.0', '0.2.0', '1.0.0'];
      return `<!-- docgen:version=${versions[v - 1]} reason: test -->\n\n## Purpose\n\nDone.`;
    };

    // Step 1: leaf documented at 0.1.0.
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg/leaf') });
    // Step 2: trunk pkg/ documented; records leaf at 0.1.0.
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg') });

    // MINOR bump: re-analyse the leaf so it lands 0.2.0. Under the
    // major-only cascade, the trunk must NOT be flagged stale by this.
    let future = (Date.now() + 60_000) / 1000;
    utimesSync(join(root, 'pkg/leaf/a.ts'), future, future);
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg/leaf') });
    assert.equal(
      needsAnalysis(root, join(root, 'pkg'), loadState(root)),
      null,
      'a child MINOR bump must NOT cascade to the parent',
    );

    // MAJOR bump: re-analyse the leaf so it lands 1.0.0. Now the trunk's
    // recorded child major (0) differs → it must be flagged child-bumped.
    future = (Date.now() + 120_000) / 1000;
    utimesSync(join(root, 'pkg/leaf/a.ts'), future, future);
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg/leaf') });
    const reason = needsAnalysis(root, join(root, 'pkg'), loadState(root));
    assert.ok(
      reason && reason.startsWith('child-bumped:'),
      `a child MAJOR bump must cascade to the parent; got: ${reason}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: patch bump in child does NOT propagate to parent', async () => {
  const root = freshRepo();
  try {
    file(root, 'pkg/leaf/a.ts', 'a');
    file(root, 'pkg/other.ts', 'o');

    let v = 0;
    const mockRunner = async () => {
      v++;
      // 1: leaf 0.1.0, 2: trunk 0.1.0, 3: leaf 0.1.1 (patch only).
      const versions = ['0.1.0', '0.1.0', '0.1.1'];
      return `<!-- docgen:version=${versions[v - 1]} reason: test -->\n\n## Purpose\n\nDone.`;
    };

    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg/leaf') });
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg') });

    // Touch the leaf file so it's stale, then re-analyse — but the LLM
    // returns a PATCH version (cosmetic change only). Trunk must not
    // propagate.
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(join(root, 'pkg/leaf/a.ts'), future, future);
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg/leaf') });

    const state = loadState(root);
    const reason = needsAnalysis(root, join(root, 'pkg'), state);
    assert.equal(reason, null, 'patch bump must not propagate — got: ' + reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeOne adds a new file → final version is minor even when LLM picks patch', async () => {
  const root = freshRepo();
  try {
    file(root, 'pkg/a.ts', 'a');
    let call = 0;
    const mockRunner = async () => {
      call++;
      // First call → 0.1.0 initial. Second call (after new file) →
      // LLM claims patch (0.1.1) but resolveVersion must escalate to minor.
      const version = call === 1 ? '0.1.0' : '0.1.1';
      return `<!-- docgen:version=${version} reason: test -->\n\n## Purpose\n\nDone.`;
    };

    const r1 = await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg') });
    assert.equal(r1.finalVersion, '0.1.0');

    // Add a new file (file-set change). Re-analyse.
    file(root, 'pkg/b.ts', 'b');
    const r2 = await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg') });
    assert.equal(r2.llmVersion, '0.1.1', 'LLM declared patch');
    assert.equal(r2.finalVersion, '0.2.0', 'resolveVersion must escalate to minor');
    assert.equal(r2.fileSetChanged, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('written README contains a normalised <!-- docgen:version=... --> line', async () => {
  const root = freshRepo();
  try {
    file(root, 'pkg/a.ts', 'a');
    const mockRunner = async () =>
      '<!-- docgen:version=0.4.2 reason: test -->\n\n## Purpose\n\nFake.';
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg') });
    const readme = readFileSync(join(root, 'pkg', 'README.md'), 'utf8');
    assert.ok(readme.startsWith('<!-- auto-generated by docgen'));
    assert.ok(readme.includes('docgen:version=0.4.2'), `version line missing: ${readme.slice(0, 200)}`);
    // The LLM's own version line must be stripped from the body so we
    // don't end up with two stacked.
    const versionLineCount = (readme.match(/docgen:version=/g) || []).length;
    assert.equal(versionLineCount, 1, 'exactly one docgen:version line in the file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findChildReadmesInState surfaces only versioned children', async () => {
  const root = freshRepo();
  try {
    file(root, 'pkg/a/x.ts', 'x');
    file(root, 'pkg/b/y.ts', 'y');
    const mockRunner = async () => '<!-- docgen:version=0.1.0 reason: t -->\n\n## Purpose\n\nDone.';
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'pkg/a') });
    // pkg/b/ NOT analysed yet.
    const state = loadState(root);
    const children = findChildReadmesInState(root, join(root, 'pkg'), state);
    assert.equal(children.length, 1);
    assert.equal(children[0].relPath, 'pkg/a');
    assert.equal(children[0].version, '0.1.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── hand-written README protection ───────────────────────────────────────

test('isHandWrittenReadme: no file → false', () => {
  const root = freshRepo();
  try {
    assert.equal(isHandWrittenReadme(join(root, 'README.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isHandWrittenReadme: docgen-marked README → false (auto-generated)', () => {
  const root = freshRepo();
  try {
    file(root, 'README.md', '<!-- auto-generated by docgen — etc -->\n\n## Purpose\n\nFake.');
    assert.equal(isHandWrittenReadme(join(root, 'README.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isHandWrittenReadme: plain README → true (must be protected)', () => {
  const root = freshRepo();
  try {
    file(root, 'README.md', '# My Important Repo\n\nHand-tuned onboarding copy here.');
    assert.equal(isHandWrittenReadme(join(root, 'README.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: protected dir returns null (excluded from automatic walk)', () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');
    file(root, 'src/README.md', '# Hand-written\n\nLoad-bearing.');
    const state = loadState(root);
    assert.equal(needsAnalysis(root, join(root, 'src'), state), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeOne refuses to overwrite a hand-written README without --force', async () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');
    const original = '# My Spec\n\nDo not lose this.';
    file(root, 'src/README.md', original);
    let called = false;
    const mockRunner = async () => {
      called = true;
      return '## Purpose\n\nGenerated.';
    };
    const res = await analyzeOne(root, {
      runner: mockRunner,
      promptText: PROMPT,
      forceDir: join(root, 'src'),
    });
    assert.equal(res.skipped, 'hand-written-readme');
    assert.equal(called, false, 'runner must NOT fire when README is protected');
    assert.equal(readFileSync(join(root, 'src', 'README.md'), 'utf8'), original,
      'original README must be preserved byte-for-byte');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeOne with --force overwrites a hand-written README (explicit opt-in)', async () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');
    file(root, 'src/README.md', '# Hand-written\n\nWill be lost.');
    const mockRunner = async () =>
      '<!-- docgen:version=0.1.0 reason: t -->\n\n## Purpose\n\nGenerated.';
    const res = await analyzeOne(root, {
      runner: mockRunner,
      promptText: PROMPT,
      forceDir: join(root, 'src'),
      force: true,
    });
    assert.ok(res.readmePath, 'force run must succeed');
    assert.equal(res.skipped, undefined);
    const readme = readFileSync(join(root, 'src', 'README.md'), 'utf8');
    assert.ok(readme.startsWith('<!-- auto-generated by docgen'),
      '--force must replace the hand-written README');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeStatus surfaces protected count separately from documented', async () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');                              // documentable
    file(root, 'lib/b.ts', 'b');
    file(root, 'lib/README.md', '# Hand-written subsystem');  // protected
    file(root, 'other/c.ts', 'c');                            // uncovered

    const mockRunner = async () =>
      '<!-- docgen:version=0.1.0 reason: t -->\n\n## Purpose\n\nDone.';
    await analyzeOne(root, { runner: mockRunner, promptText: PROMPT, forceDir: join(root, 'src') });

    const s = computeStatus(root);
    assert.equal(s.protected, 1, 'lib/ should be counted as protected');
    assert.equal(s.documented, 1, 'src/ should be the documented one');
    assert.equal(s.uncovered, 2, 'other/ and root `.` (trunk) should be uncovered');
    // lib/ should NOT appear in next-todo since it's protected.
    const todoDirs = s.dirs
      .filter((d) => !d.protected && (!d.analyzed || d.needsReanalysis))
      .map((d) => d.dir);
    assert.ok(!todoDirs.includes('lib'), 'protected lib/ must not appear in todo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── parallel orchestration ───────────────────────────────────────────────

test('analyzeAllParallel completes every dir with parallel=4 — no state races', async () => {
  const root = freshRepo();
  try {
    // 8 sibling leaf dirs at depth 1 → should all run in 2 batches of 4.
    for (let i = 0; i < 8; i++) {
      file(root, `pkg${i}/a.ts`, `// pkg${i}`);
    }
    let callCount = 0;
    const inFlight = new Set();
    let maxInFlight = 0;
    const mockRunner = async ({ context }) => {
      callCount++;
      const id = `r${callCount}`;
      inFlight.add(id);
      maxInFlight = Math.max(maxInFlight, inFlight.size);
      // Tiny delay so multiple calls actually overlap.
      await new Promise((r) => setTimeout(r, 30));
      inFlight.delete(id);
      // Echo the directory back in the version reason so we can
      // verify state landed for ALL dirs (not just some surviving
      // a race).
      const dirMatch = context.match(/# Directory: (\S+)/);
      const dirName = dirMatch ? dirMatch[1] : 'unknown';
      return `<!-- docgen:version=0.1.0 reason: ${dirName} -->\n\n## Purpose\n\nFake for ${dirName}.`;
    };

    const { done, skipped } = await analyzeAllParallel(root, {
      runner: mockRunner,
      promptText: PROMPT,
      parallel: 4,
    });

    // 8 leaves + 1 root trunk = 9 total dirs analysed.
    assert.equal(done, 9, `expected 9 dirs analysed, got ${done}`);
    assert.equal(skipped, 0);
    assert.ok(maxInFlight >= 2, `parallel=4 should overlap; max-in-flight was ${maxInFlight}`);
    assert.ok(maxInFlight <= 4, `parallel cap exceeded: ${maxInFlight}`);

    // Every dir must be in state — no race-clobbering of entries.
    const state = loadState(root);
    for (let i = 0; i < 8; i++) {
      assert.ok(state.directories[`pkg${i}`], `pkg${i} missing from state`);
      assert.equal(state.directories[`pkg${i}`].version, '0.1.0');
    }
    assert.ok(state.directories['.'], 'root trunk missing from state');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeAllParallel keeps bottom-up ordering: trunk waits for leaves', async () => {
  const root = freshRepo();
  try {
    // pkg/ has leaves a/, b/, c/. Trunk pkg/ must wait until a/b/c are done.
    file(root, 'pkg/a/x.ts', 'a');
    file(root, 'pkg/b/x.ts', 'b');
    file(root, 'pkg/c/x.ts', 'c');

    const completionOrder = [];
    const mockRunner = async ({ context }) => {
      await new Promise((r) => setTimeout(r, 20));
      const dirMatch = context.match(/# Directory: (\S+)/);
      const dirName = dirMatch ? dirMatch[1] : 'unknown';
      completionOrder.push(dirName);
      return `<!-- docgen:version=0.1.0 reason: ok -->\n\n## Purpose\n\n${dirName}.`;
    };

    await analyzeAllParallel(root, {
      runner: mockRunner,
      promptText: PROMPT,
      parallel: 4,
    });

    // The three leaves must complete BEFORE the trunk `pkg`, which
    // must complete BEFORE the root `.`. (Leaves can complete in any
    // order among themselves.)
    const trunkIdx = completionOrder.indexOf('pkg');
    const rootIdx = completionOrder.indexOf('.');
    for (const leaf of ['pkg/a', 'pkg/b', 'pkg/c']) {
      const leafIdx = completionOrder.indexOf(leaf);
      assert.ok(leafIdx >= 0, `${leaf} not analysed`);
      assert.ok(leafIdx < trunkIdx, `${leaf} (idx ${leafIdx}) must finish before pkg (${trunkIdx})`);
    }
    assert.ok(trunkIdx < rootIdx, `pkg (${trunkIdx}) must finish before . (${rootIdx})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeAllParallel analyses each dir at most once per run — livelock guard for dirs that keep mutating', async () => {
  const root = freshRepo();
  try {
    // Two leaf dirs at the same depth. `loopy/` holds a file whose mtime
    // gets bumped into the future by the runner on every analysis —
    // simulating an external process (the live pre-push hook) re-touching
    // the directory that holds it WHILE docgen is mid-sweep. Because
    // analyzeOne snapshots file mtimes *before* calling the runner, the
    // fingerprint it records is already stale, so without a guard `loopy`
    // is re-picked on every outer iteration → infinite loop (observed in
    // the wild on tools/secret-scrub/githooks: 5 rewrites, never drained).
    file(root, 'stable/a.ts', 'export const a = 1;');
    const loopyFile = file(root, 'loopy/hook.sh', '#!/bin/sh\necho hi\n');

    const calls = { loopy: 0, other: 0 };
    const churn = [];
    const runner = async ({ context }) => {
      const m = context.match(/# Directory: (\S+)/);
      const dir = m ? m[1] : 'unknown';
      if (dir === 'loopy') {
        calls.loopy++;
        // Convert a regressed (infinite) loop into a clear test failure
        // instead of a hang.
        if (calls.loopy > 4) {
          throw new Error(`livelock: loopy analysed ${calls.loopy}× in one run`);
        }
        // External toucher: bump the source file's mtime into the future
        // AFTER analyzeOne snapshotted it → dir stays needsAnalysis-positive.
        const future = Date.now() + 60_000;
        utimesSync(loopyFile, future / 1000, future / 1000);
      } else {
        calls.other++;
      }
      return `<!-- docgen:version=0.1.0 reason: ${dir} -->\n\n## Purpose\n\n${dir}.`;
    };

    const summary = await analyzeAllParallel(root, {
      runner,
      promptText: PROMPT,
      parallel: 2,
      onProgress: (r) => { if (r.skipped === 'churn') churn.push(r.picked); },
    });

    // The mutating dir is analysed EXACTLY once despite staying stale.
    assert.equal(calls.loopy, 1, `loopy must be analysed once, was ${calls.loopy}`);
    // And the churn is surfaced (not silently swallowed) so an operator
    // can see a dir is changing underneath docgen.
    assert.ok(churn.includes('loopy'), 'expected a churn signal for loopy');
    // Sweep still terminated and did real work on the other dirs.
    assert.ok(summary.done >= 1, `expected progress, done=${summary.done}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('saveState + loadState round-trip without data loss', () => {
  const root = freshRepo();
  try {
    const s1 = {
      version: 1,
      lastRun: '2026-05-22T22:00:00Z',
      directories: {
        'a': { lastAnalyzed: '2026-05-22T22:00:00Z', files: { 'x.ts': 123 } },
        'b': { lastAnalyzed: '2026-05-22T22:00:00Z', files: { 'y.ts': 456 } },
      },
    };
    saveState(root, s1);
    const s2 = loadState(root);
    assert.deepEqual(s2, s1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── defensive ENOENT handling (worktree-cleanup race) ────────────────────

test('analyzeOne returns skipped:"vanished" when target dir no longer exists', async () => {
  const root = freshRepo();
  try {
    // Create a directory, then delete it before analyzeOne runs.
    // Simulates the integrate-public-* worktree-cleanup race where a
    // detached background docgen runs after the parent automation has
    // rm -rf'd the worktree.
    const gone = join(root, 'will-vanish');
    mkdirSync(gone);
    writeFileSync(join(gone, 'a.ts'), 'export const x = 1;\n');
    rmSync(gone, { recursive: true, force: true });
    const result = await analyzeOne(root, {
      runner: async () => { throw new Error('runner should not be called for vanished dir'); },
      promptText: 'unused',
      forceDir: gone,
    });
    assert.equal(result.skipped, 'vanished');
    assert.match(result.message ?? '', /no longer exists|cleaned mid-run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel batch survives one analyzeOne throwing — others still land', async () => {
  const root = freshRepo();
  try {
    // Build 3 sibling dirs at same depth. Mock runner throws for one,
    // succeeds for the other two. Promise.allSettled in the batch
    // loop means survivors must still get their READMEs written.
    for (const name of ['a', 'b', 'c']) {
      const d = join(root, name);
      mkdirSync(d);
      writeFileSync(join(d, 'f.ts'), `export const ${name} = 1;\n`);
    }
    const runner = async ({ context }) => {
      const dirMatch = context.match(/# Directory: (\S+)/);
      const name = dirMatch ? dirMatch[1] : '';
      if (name === 'b') throw new Error('synthetic upstream failure');
      return `<!-- docgen:version=0.1.0 reason: ok -->\n\n## Purpose\n\n${name}.`;
    };
    const summary = await analyzeAllParallel(root, {
      runner,
      promptText: PROMPT,
      parallel: 3,
    });
    // a + c (survivors) + the root trunk = 3. b throws and is skipped —
    // and, crucially, NOT retried: before the livelock guard, b (which
    // never gets a state entry) was re-picked at the deepest depth on
    // every outer iteration, so the sweep hung forever and never reached
    // the root trunk. Now it drains and the trunk gets documented despite
    // a sibling failing.
    assert.equal(summary.done, 3);
    assert.ok(summary.skipped >= 1);
    assert.equal(existsSync(join(root, 'a/README.md')), true);
    assert.equal(existsSync(join(root, 'c/README.md')), true);
    assert.equal(existsSync(join(root, 'README.md')), true,
      'root trunk should be documented even though sibling b failed');
    assert.equal(existsSync(join(root, 'b/README.md')), false,
      'the dir whose runner threw must NOT have a README');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── --changed scope filter ───────────────────────────────────────────────

test('analyzeAllParallel --changed: only changed dir + ancestors are analyzed, unrelated sibling is not', async () => {
  const root = freshRepo();
  try {
    // Tree: pkg/leaf/leaf.ts, pkg/trunk.ts, other/sibling.ts
    // changed: ['pkg/leaf'] → should analyze pkg/leaf AND pkg AND root (.),
    // but NOT other/.
    file(root, 'pkg/leaf/leaf.ts', 'export const leaf = 1;');
    file(root, 'pkg/trunk.ts', 'export const trunk = 1;');
    file(root, 'other/sibling.ts', 'export const sibling = 1;');

    const analyzedDirs = [];
    const mockRunner = async ({ context }) => {
      const dirMatch = context.match(/# Directory: (\S+)/);
      const dirName = dirMatch ? dirMatch[1] : 'unknown';
      analyzedDirs.push(dirName);
      return `<!-- docgen:version=0.1.0 reason: test -->\n\n## Purpose\n\nDone for ${dirName}.`;
    };

    await analyzeAllParallel(root, {
      runner: mockRunner,
      promptText: PROMPT,
      parallel: 2,
      changed: ['pkg/leaf'],
    });

    // pkg/leaf, pkg, and root (.) must be analyzed.
    assert.ok(analyzedDirs.includes('pkg/leaf'), `pkg/leaf must be analyzed; got: ${analyzedDirs}`);
    assert.ok(analyzedDirs.includes('pkg'), `pkg must be analyzed (ancestor); got: ${analyzedDirs}`);
    assert.ok(analyzedDirs.includes('.'), `root must be analyzed (ancestor); got: ${analyzedDirs}`);

    // other/ must NOT be analyzed.
    assert.ok(!analyzedDirs.includes('other'), `other/ must NOT be analyzed; got: ${analyzedDirs}`);

    // other/README.md must not exist.
    assert.equal(existsSync(join(root, 'other', 'README.md')), false,
      'other/README.md must not exist when other/ is excluded by --changed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeAllParallel without --changed: full sweep analyzes all dirs', async () => {
  const root = freshRepo();
  try {
    // Same tree as above but no --changed → all dirs must be analyzed.
    file(root, 'pkg/leaf/leaf.ts', 'export const leaf = 1;');
    file(root, 'pkg/trunk.ts', 'export const trunk = 1;');
    file(root, 'other/sibling.ts', 'export const sibling = 1;');

    const analyzedDirs = [];
    const mockRunner = async ({ context }) => {
      const dirMatch = context.match(/# Directory: (\S+)/);
      const dirName = dirMatch ? dirMatch[1] : 'unknown';
      analyzedDirs.push(dirName);
      return `<!-- docgen:version=0.1.0 reason: test -->\n\n## Purpose\n\nDone for ${dirName}.`;
    };

    await analyzeAllParallel(root, {
      runner: mockRunner,
      promptText: PROMPT,
      parallel: 2,
      // no `changed` — full sweep
    });

    // All dirs must be analyzed: pkg/leaf, pkg, other, root (.).
    for (const expected of ['pkg/leaf', 'pkg', 'other', '.']) {
      assert.ok(analyzedDirs.includes(expected),
        `${expected} must be analyzed in full sweep; got: ${analyzedDirs}`);
    }
    assert.equal(existsSync(join(root, 'other', 'README.md')), true,
      'other/README.md must exist in full sweep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Change 1: data-only dir skip ─────────────────────────────────────────

test('needsAnalysis: data-only dir (json+csv, no children) returns null', () => {
  const root = freshRepo();
  try {
    file(root, 'data/records.json', '[{"a":1}]');
    file(root, 'data/prices.csv', 'date,price\n2024-01-01,1.0\n');
    const state = loadState(root);
    const result = needsAnalysis(root, join(root, 'data'), state);
    assert.equal(result, null, `data-only dir must be skipped; got: ${result}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: sibling dir with .ts is analyzed (not data-only)', () => {
  const root = freshRepo();
  try {
    file(root, 'data/records.json', '[{"a":1}]');
    file(root, 'src/index.ts', 'export const x = 1;');
    const state = loadState(root);
    const srcResult = needsAnalysis(root, join(root, 'src'), state);
    assert.ok(srcResult !== null, `src dir with .ts must be analyzed; got: ${srcResult}`);
    const dataResult = needsAnalysis(root, join(root, 'data'), state);
    assert.equal(dataResult, null, `data-only dir must still be skipped; got: ${dataResult}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: mixed dir (.ts + .json) is analyzed (NOT skipped)', () => {
  const root = freshRepo();
  try {
    file(root, 'pkg/a.ts', 'export const a = 1;');
    file(root, 'pkg/b.json', '{"key":"value"}');
    const state = loadState(root);
    const result = needsAnalysis(root, join(root, 'pkg'), state);
    assert.ok(result !== null, `mixed dir must NOT be skipped; got: ${result}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: dir with only .sql files is analyzed (not data-only)', () => {
  const root = freshRepo();
  try {
    file(root, 'migrations/001.sql', 'CREATE TABLE foo (id INT);');
    file(root, 'migrations/002.sql', 'ALTER TABLE foo ADD col TEXT;');
    const state = loadState(root);
    const result = needsAnalysis(root, join(root, 'migrations'), state);
    assert.ok(result !== null, `.sql-only dir must NOT be skipped; got: ${result}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: prose-only dir (.md) is SKIPPED — no code symbols to map', () => {
  const root = freshRepo();
  try {
    file(root, 'docs/guide.md', '# Guide\n\nSome guide.');
    file(root, 'docs/api.md', '# API\n\nSome API docs.');
    const state = loadState(root);
    assert.equal(needsAnalysis(root, join(root, 'docs'), state), null,
      'prose-only (.md) dir must be skipped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: research dir (hypothesis.md + status.json, no code) is SKIPPED', () => {
  // The real pbx-platform failure mode: ~12k dirs each a .md writeup + .json
  // data, no code. Must be skipped, not documented.
  const root = freshRepo();
  try {
    file(root, 'strategies/0001/hypothesis.md', '# Hypothesis\n\nidea.');
    file(root, 'strategies/0001/status.json', '{"done":true}');
    const state = loadState(root);
    assert.equal(needsAnalysis(root, join(root, 'strategies/0001'), state), null,
      'data+prose research dir (no code) must be skipped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: data-only dir WITH documented children is analyzed (trunk role)', async () => {
  // A dir that holds only .json files but also has a documented child subdir
  // acts as a trunk. It should NOT be skipped even if its own files are data.
  const root = freshRepo();
  try {
    file(root, 'data/records.json', '[{"a":1}]');
    file(root, 'data/processed/index.ts', 'export const x = 1;');
    // Analyze the child so it has a state entry + README.
    const mockRunner = async () =>
      '<!-- docgen:version=0.1.0 reason: t -->\n\n## Purpose\n\nDone.';
    await analyzeOne(root, {
      runner: mockRunner,
      promptText: PROMPT,
      forceDir: join(root, 'data/processed'),
    });
    const state = loadState(root);
    const result = needsAnalysis(root, join(root, 'data'), state);
    assert.ok(result !== null, `data dir with documented children must NOT be skipped; got: ${result}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Change 2: selectFiles respects .gitignore (tracked-only) ─────────────

test('selectFiles excludes gitignored and untracked files, includes tracked ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'docgen-git-'));
  try {
    // Initialise a real git repo so ls-files works.
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'pipe' });

    // pkg/ with:
    //   - tracked.ts       (git add + commit → tracked)
    //   - ignored.json     (in .gitignore → not tracked)
    //   - untracked.ts     (present on disk, never added → untracked)
    mkdirSync(join(root, 'pkg'));
    writeFileSync(join(root, 'pkg', 'tracked.ts'), 'export const x = 1;');
    writeFileSync(join(root, 'pkg', 'ignored.json'), '{"ignored":true}');
    writeFileSync(join(root, '.gitignore'), 'pkg/ignored.json\n');
    execFileSync('git', ['add', 'pkg/tracked.ts', '.gitignore'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'pipe' });

    // Create untracked.ts AFTER commit, so it's on disk but not tracked.
    writeFileSync(join(root, 'pkg', 'untracked.ts'), 'export const y = 2;');

    const files = selectFiles(join(root, 'pkg'), root).map((f) => f.name);
    assert.ok(files.includes('tracked.ts'), 'tracked.ts must be included');
    assert.ok(!files.includes('ignored.json'), 'gitignored file must be excluded');
    assert.ok(!files.includes('untracked.ts'), 'untracked file must be excluded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectFiles falls back to full behavior when not in a git repo', () => {
  // In a non-git dir (our freshRepo() — no git init), tracked-set is null
  // and all otherwise-eligible files should still be returned.
  const root = freshRepo();
  try {
    file(root, 'pkg/a.ts', 'export const a = 1;');
    file(root, 'pkg/b.ts', 'export const b = 2;');
    // Pass root explicitly so selectFiles can look up the tracked set.
    const files = selectFiles(join(root, 'pkg'), root).map((f) => f.name);
    assert.ok(files.includes('a.ts'), 'a.ts must be included in non-git repo');
    assert.ok(files.includes('b.ts'), 'b.ts must be included in non-git repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Change 3: --max run-size guard ───────────────────────────────────────

test('analyzeAllParallel: --max 2 stops after 2 dirs even when 5+ are actionable', async () => {
  const root = freshRepo();
  try {
    // 5 sibling leaf dirs — all actionable on a fresh repo.
    for (let i = 0; i < 5; i++) {
      file(root, `dir${i}/a.ts`, `export const x${i} = ${i};`);
    }
    let callCount = 0;
    const mockRunner = async ({ context }) => {
      callCount++;
      const dirMatch = context.match(/# Directory: (\S+)/);
      const dirName = dirMatch ? dirMatch[1] : 'unknown';
      return `<!-- docgen:version=0.1.0 reason: test -->\n\n## Purpose\n\n${dirName}.`;
    };

    const { done } = await analyzeAllParallel(root, {
      runner: mockRunner,
      promptText: PROMPT,
      parallel: 4,
      max: 2,
    });

    assert.equal(done, 2, `--max 2 must stop after 2 dirs; got done=${done}`);
    assert.equal(callCount, 2, `runner must be called exactly 2 times; got ${callCount}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
