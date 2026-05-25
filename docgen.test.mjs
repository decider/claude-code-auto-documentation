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
  expandScopeWithAncestors,
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

test('needsAnalysis: null when file content hashes match state', () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');
    const dir = join(root, 'src');
    const files = selectFiles(dir);
    const state = {
      version: 2,
      lastRun: null,
      directories: {
        src: {
          lastAnalyzed: new Date().toISOString(),
          files: Object.fromEntries(files.map((x) => [x.name, x.hash])),
        },
      },
    };
    assert.equal(needsAnalysis(root, dir, state), null, 'fresh dir should return null');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: file-modified when file CONTENT changes (not just mtime)', () => {
  const root = freshRepo();
  try {
    const f = file(root, 'src/a.ts', 'original');
    const dir = join(root, 'src');
    const files = selectFiles(dir);
    const state = {
      version: 2,
      lastRun: null,
      directories: {
        src: {
          lastAnalyzed: new Date().toISOString(),
          files: Object.fromEntries(files.map((x) => [x.name, x.hash])),
        },
      },
    };
    // Change content — hash will differ.
    writeFileSync(f, 'modified content');
    assert.equal(needsAnalysis(root, dir, state), 'file-modified');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('needsAnalysis: null when mtime changes but content is identical (durable across clones)', () => {
  const root = freshRepo();
  try {
    const f = file(root, 'src/a.ts', 'unchanged');
    const dir = join(root, 'src');
    const files = selectFiles(dir);
    const state = {
      version: 2,
      lastRun: null,
      directories: {
        src: {
          lastAnalyzed: new Date().toISOString(),
          files: Object.fromEntries(files.map((x) => [x.name, x.hash])),
        },
      },
    };
    // Touch the file — mtime advances, content is identical. This is
    // exactly what happens on a fresh `git clone`: every file's mtime
    // is the moment of checkout, NOT when it was last modified. With
    // hash-based staleness, this scenario must NOT trigger re-analysis.
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(f, future, future);
    assert.equal(needsAnalysis(root, dir, state), null,
      'mtime change with identical content must NOT be flagged stale');
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
      version: 2,
      lastRun: null,
      directories: {
        src: {
          lastAnalyzed: new Date().toISOString(),
          files: Object.fromEntries(filesBefore.map((x) => [x.name, x.hash])),
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

    // Stale-out src by changing its file content (the hash will diff).
    writeFileSync(join(root, 'src', 'a.ts'), 'a-modified');

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

    // Change the leaf file content so it's stale, then re-analyse —
    // but the LLM returns a PATCH version (cosmetic change only).
    // Trunk must NOT propagate.
    writeFileSync(join(root, 'pkg/leaf/a.ts'), 'a-modified');
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

// ─── livelock guard ───────────────────────────────────────────────────────

test('analyzeAllParallel analyses each dir at most once per run — livelock guard for dirs that keep mutating', async () => {
  const root = freshRepo();
  try {
    // Two leaf dirs at the same depth. `loopy/` holds a file whose CONTENT
    // changes during analysis — simulating an external process rewriting a
    // file in the directory WHILE docgen is mid-sweep. Because analyzeOne
    // records the file hashes BEFORE calling the runner, any content change
    // that happens during the runner call means the recorded hash is already
    // stale when the next outer iteration walks the tree. Without a guard,
    // `loopy` is re-picked on every outer iteration → infinite loop.
    file(root, 'stable/a.ts', 'export const a = 1;');
    const loopyFile = file(root, 'loopy/hook.sh', '#!/bin/sh\necho hi\n');

    const calls = { loopy: 0, other: 0 };
    const churn = [];
    let loopyCallCount = 0;
    const runner = async ({ context }) => {
      const m = context.match(/# Directory: (\S+)/);
      const dir = m ? m[1] : 'unknown';
      if (dir === 'loopy') {
        calls.loopy++;
        loopyCallCount++;
        // Convert a regressed (infinite) loop into a clear test failure
        // instead of a hang.
        if (calls.loopy > 4) {
          throw new Error(`livelock: loopy analysed ${calls.loopy}× in one run`);
        }
        // Mutate the file content DURING the runner call so the hash
        // recorded by analyzeOne is already stale when the next outer
        // iteration runs needsAnalysis → dir stays stale indefinitely
        // without the livelock guard.
        writeFileSync(loopyFile, `#!/bin/sh\necho hi_${loopyCallCount}\n`);
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

// ─── --scope plumbing ─────────────────────────────────────────────────────

test('expandScopeWithAncestors: file path → its parent dir + all ancestors', () => {
  const root = freshRepo();
  try {
    file(root, 'a/b/c/file.ts', 'x');
    const expanded = expandScopeWithAncestors(root, [join(root, 'a/b/c/file.ts')]);
    const rels = [...expanded].map((p) => p.replace(root + '/', '').replace(root, '.'));
    assert.ok(rels.includes('a/b/c'), `expected a/b/c, got: ${rels}`);
    assert.ok(rels.includes('a/b'), `expected a/b, got: ${rels}`);
    assert.ok(rels.includes('a'), `expected a, got: ${rels}`);
    assert.ok(rels.includes('.'), `expected . (root), got: ${rels}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('expandScopeWithAncestors: directory path → itself + ancestors', () => {
  const root = freshRepo();
  try {
    file(root, 'a/b/keep.ts', 'x'); // makes a/b a real dir
    const expanded = expandScopeWithAncestors(root, [join(root, 'a/b')]);
    const rels = [...expanded].map((p) => p.replace(root + '/', '').replace(root, '.'));
    assert.ok(rels.includes('a/b'));
    assert.ok(rels.includes('a'));
    assert.ok(rels.includes('.'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('expandScopeWithAncestors: relative paths get resolved against root', () => {
  const root = freshRepo();
  try {
    file(root, 'x/y/z.ts', 'x');
    const expanded = expandScopeWithAncestors(root, ['x/y/z.ts']);
    const rels = [...expanded].map((p) => p.replace(root + '/', '').replace(root, '.'));
    assert.ok(rels.includes('x/y'), `expected x/y, got: ${rels}`);
    assert.ok(rels.includes('x'));
    assert.ok(rels.includes('.'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('expandScopeWithAncestors: paths outside root are dropped', () => {
  const root = freshRepo();
  try {
    const expanded = expandScopeWithAncestors(root, ['/tmp/outside.ts']);
    assert.equal(expanded.size, 0, 'paths outside root must be excluded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeAllParallel with scope: only re-analyses dirs in scope + ancestors', async () => {
  const root = freshRepo();
  try {
    file(root, 'touched/x.ts', 'a');
    file(root, 'untouched/y.ts', 'b');

    const analysed = [];
    const mockRunner = async ({ context }) => {
      const dirMatch = context.match(/# Directory: (\S+)/);
      analysed.push(dirMatch ? dirMatch[1] : '?');
      return '<!-- docgen:version=0.1.0 reason: t -->\n\n## Purpose\n\nDone.';
    };

    // Scope to just `touched/` — expanded should include `touched`
    // and root `.`, but NOT `untouched/`.
    const scope = expandScopeWithAncestors(root, [join(root, 'touched')]);

    await analyzeAllParallel(root, {
      runner: mockRunner,
      promptText: PROMPT,
      parallel: 1,
      scope,
    });

    assert.ok(analysed.includes('touched'), `touched should have been analysed: ${analysed}`);
    assert.ok(!analysed.includes('untouched'),
      `untouched must NOT have been analysed (out of scope): ${analysed}`);
    assert.ok(analysed.includes('.'),
      `root . SHOULD be analysed (ancestor of touched, so trunk bubble-up works): ${analysed}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeAllParallel with empty scope set: noop, no runner calls', async () => {
  const root = freshRepo();
  try {
    file(root, 'src/a.ts', 'a');
    let calls = 0;
    const mockRunner = async () => {
      calls++;
      return '<!-- docgen:version=0.1.0 reason: t -->\n\n## Purpose\n\nDone.';
    };

    // Empty scope set = "analyse nothing". Guards the edge case where
    // the hook computes an empty scope from a diff that touched only
    // files we filter out (e.g. binaries, lock files).
    await analyzeAllParallel(root, {
      runner: mockRunner,
      promptText: PROMPT,
      parallel: 1,
      scope: new Set(),
    });
    assert.equal(calls, 0, 'empty scope must produce zero runner calls');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('expandScopeWithAncestors: empty input → empty set', () => {
  const root = freshRepo();
  try {
    assert.equal(expandScopeWithAncestors(root, []).size, 0);
    assert.equal(
      expandScopeWithAncestors(root, [null, undefined, ''].filter(Boolean)).size,
      0,
      'falsy entries should be silently dropped',
    );
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

test('saveState + loadState round-trip without data loss', () => {
  const root = freshRepo();
  try {
    const s1 = {
      version: 2,
      lastRun: '2026-05-22T22:00:00Z',
      directories: {
        'a': { lastAnalyzed: '2026-05-22T22:00:00Z', files: { 'x.ts': 'abc123' } },
        'b': { lastAnalyzed: '2026-05-22T22:00:00Z', files: { 'y.ts': 'def456' } },
      },
    };
    saveState(root, s1);
    const s2 = loadState(root);
    assert.deepEqual(s2, s1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
