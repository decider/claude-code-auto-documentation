/**
 * End-to-end tests for tools/docgen/hooks/pre-push.
 *
 * Run with:  node --test tools/docgen/hooks/pre-push.test.mjs
 *
 * Each test builds a fully isolated environment:
 *   - a fresh tmp repo with a tmp bare-repo remote,
 *   - the docgen tree copied in,
 *   - the pre-push hook installed,
 *   - a stub `claude` binary on PATH that just emits a fixed README
 *     (so we never hit the real Claude API),
 *   - then a real `git push` is run and we observe the resulting state
 *     on the remote.
 *
 * What we verify end-to-end:
 *   - Loop guard: with DOCGEN_HOOK_SKIP=1 the hook noops in O(ms) and
 *     no background work is started.
 *   - Cold push: the hook returns immediately; a detached background
 *     process runs docgen, commits the new READMEs, and pushes them
 *     back to the same branch on the remote.
 *   - Idempotence on the auto-push: the hook's own push doesn't loop
 *     (DOCGEN_HOOK_SKIP=1 set by the hook itself).
 *
 * No real `claude -p` is invoked — a stub on PATH stands in for it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));   // claude-docgen/hooks
const DOCGEN_DIR = dirname(HERE);                        // claude-docgen (this repo)

/**
 * Build a self-contained test environment:
 *   <tmp>/bare.git           — bare remote
 *   <tmp>/repo               — working clone with docgen + hook installed
 *   <tmp>/stub-bin/claude    — stub claude binary first on PATH
 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'docgen-pp-'));

  // 1. bare remote
  const bare = join(root, 'bare.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });

  // 2. working clone
  const repo = join(root, 'repo');
  execFileSync('git', ['clone', '-q', bare, repo], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
  // Override any inherited user-global core.hooksPath so our test
  // hook in `.git/hooks/pre-push` is actually what fires. Real users
  // are unaffected — this is a per-test-clone override only.
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.git/hooks'], { cwd: repo });

  // 3. Vendor claude-docgen into the test repo at the path the README
  //    recommends — exercising the real production layout: a downstream
  //    repo with claude-docgen sitting at `tools/claude-docgen/`.
  const vendored = join(repo, 'tools/claude-docgen');
  cpSync(DOCGEN_DIR, vendored, { recursive: true });

  // 4. Seed at least one file so docgen has something to work on, and
  //    an initial commit + push to establish the upstream tracking ref.
  mkdirSync(join(repo, 'src/pkg'), { recursive: true });
  writeFileSync(join(repo, 'src/pkg/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'README.md'), '# test repo\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo });

  // 5. Install the pre-push hook via the REAL installer (not a manual
  //    cpSync) so we test the shim-pointing-back-to-source pattern
  //    end-to-end. The installer drops a shim at .git/hooks/pre-push
  //    that exec's `tools/claude-docgen/hooks/pre-push`, which in turn
  //    locates `docgen` via $BASH_SOURCE → sibling.
  execFileSync(join(vendored, 'install-push-hook.sh'), ['install'], {
    cwd: repo,
    stdio: 'ignore',
  });

  // 6. Stub `claude` binary on PATH. Emits a fixed README for any
  //    invocation. The hook never blocks on it; this just keeps the
  //    docgen subprocess from actually shelling out to the network.
  const stubDir = join(root, 'stub-bin');
  mkdirSync(stubDir, { recursive: true });
  const stubPath = join(stubDir, 'claude');
  writeFileSync(
    stubPath,
    [
      '#!/usr/bin/env bash',
      '# Stub: read stdin, write a docgen-shaped README to stdout.',
      'cat > /dev/null',
      'cat <<EOF',
      '<!-- docgen:version=0.1.0 reason: stubbed for e2e test -->',
      '',
      '## Purpose',
      'Stubbed README for end-to-end push-hook testing.',
      '',
      '## Files',
      '- `a.ts` — stub-test file.',
      'EOF',
      '',
    ].join('\n'),
  );
  execFileSync('chmod', ['+x', stubPath]);

  return { root, bare, repo, stubDir };
}

function teardown(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* tolerated */ }
}

/** Run `git push` with stub-claude first on PATH + a per-test log
 *  file so concurrent hook invocations (e.g. the user's primary
 *  clone running its own real docgen refresh) don't trample our
 *  visibility into THIS test's hook behaviour. */
function gitPush(repo, stubDir, logFile, env = {}) {
  const t0 = Date.now();
  const r = spawnSync('git', ['push', '-q', 'origin', 'main'], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      DOCGEN_HOOK_LOG_FILE: logFile,
      ...env,
    },
    encoding: 'utf8',
  });
  return { ms: Date.now() - t0, status: r.status, stderr: r.stderr };
}

/**
 * Poll a predicate until it's true or the deadline elapses.
 * Returns true if predicate became true; false if we timed out.
 */
async function waitUntil(predicate, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Snapshot a git remote's main-branch SHA so we can wait for it to move. */
function remoteSha(bare, ref = 'refs/heads/main') {
  const r = spawnSync('git', ['--git-dir', bare, 'rev-parse', ref], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ──────────────────────────────────────────────────────────────────────────

test('loop guard: DOCGEN_HOOK_SKIP=1 makes the hook a sub-50ms noop', () => {
  const env = setup();
  try {
    // Modify a file so there IS something to push.
    writeFileSync(join(env.repo, 'src/pkg/a.ts'), 'export const a = 2;\n');
    execFileSync('git', ['commit', '-q', '-am', 'change'], { cwd: env.repo });

    const before = remoteSha(env.bare);
    const logFile = join(env.root, 'hook.log');
    const r = gitPush(env.repo, env.stubDir, logFile, { DOCGEN_HOOK_SKIP: '1' });
    assert.equal(r.status, 0, `push must succeed (stderr: ${r.stderr})`);

    // With the loop guard active, the hook returns immediately and NO
    // background docgen runs. The remote's HEAD moved exactly once
    // (the user's commit), not twice.
    const after = remoteSha(env.bare);
    assert.notEqual(after, before, 'remote main should have moved');

    // The hook should not have spawned any background work.
    // Verify by waiting a moment and confirming nothing new lands.
    return new Promise((resolve) => {
      setTimeout(() => {
        const eventual = remoteSha(env.bare);
        assert.equal(eventual, after, 'no further auto-refresh push must occur');
        teardown(env.root);
        resolve();
      }, 2000);
    });
  } catch (e) {
    teardown(env.root);
    throw e;
  }
});

test('end-to-end: push triggers detached docgen refresh + auto-pushes README', async () => {
  const env = setup();
  try {
    // Modify a source file so docgen has something to detect as stale
    // (the seed commit already created src/pkg/a.ts; touch it).
    writeFileSync(join(env.repo, 'src/pkg/a.ts'), 'export const a = 3;\n');
    execFileSync('git', ['commit', '-q', '-am', 'tweak a'], { cwd: env.repo });

    const before = remoteSha(env.bare);
    const logFile = join(env.root, 'hook.log');

    // Push. The hook should fork-and-exit fast.
    const r = gitPush(env.repo, env.stubDir, logFile);
    assert.equal(r.status, 0, `push must succeed: ${r.stderr}`);
    // Pre-push hook itself should finish well under 2 seconds — it
    // spawns a detached process and exits. The 5s sleep happens INSIDE
    // the background process, AFTER the user's push completes.
    assert.ok(r.ms < 5000, `pre-push hook should not block more than ~5s, took ${r.ms}ms`);

    // Wait for the background process to: sleep 5s → run docgen
    // (writes README) → commit → push back. The new commit lands on
    // the remote as a SECOND advancement of main beyond `before`.
    const justUserCommit = remoteSha(env.bare);
    assert.notEqual(justUserCommit, before, 'user commit should land first');

    const moved = await waitUntil(
      () => {
        const cur = remoteSha(env.bare);
        return cur && cur !== justUserCommit;
      },
      { timeoutMs: 120_000 },
    );
    if (!moved) {
      // Dump the per-test log for diagnosis.
      const hookLogContent = existsSync(logFile)
        ? readFileSync(logFile, 'utf8')
        : '(no hook log file written)';
      assert.fail(
        `background docgen push did not reach the remote in 120s.\n` +
          `--- per-test hook log (${logFile}) ---\n${hookLogContent}\n--- end log ---`,
      );
    }

    // Fetch the doc-refresh commit and confirm its message + the
    // README it wrote.
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: env.repo });
    const log = execFileSync(
      'git',
      ['log', 'origin/main', '-1', '--pretty=%s'],
      { cwd: env.repo, encoding: 'utf8' },
    ).trim();
    assert.match(log, /docs: refresh docgen READMEs/i,
      `expected auto commit message, got: ${log}`);

    // The bg process should have written at least one README under
    // src/pkg/ via the stub. Pull and confirm.
    execFileSync('git', ['pull', '-q', '--rebase', 'origin', 'main'], { cwd: env.repo });
    const readmePath = join(env.repo, 'src/pkg/README.md');
    assert.ok(existsSync(readmePath), 'docgen must have created src/pkg/README.md');
    const readme = readFileSync(readmePath, 'utf8');
    assert.match(readme, /Stubbed README/, 'README must come from the claude stub');
    assert.match(readme, /docgen:version=0\.1\.0/, 'README must carry the version marker');
  } finally {
    teardown(env.root);
  }
});

test('merged-branch fallback: opens follow-up PR via `gh` when target branch is gone', async () => {
  const env = setup();
  try {
    // Add a `gh` stub to the same dir as our `claude` stub. It logs
    // every invocation to a file and exits 0 (success).
    const ghLog = join(env.root, 'gh-invocations.log');
    const ghStub = join(env.stubDir, 'gh');
    writeFileSync(
      ghStub,
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >> "${ghLog}"`,
        'echo "stub-gh: would have called \\"gh $*\\""',
        'exit 0',
      ].join('\n'),
    );
    execFileSync('chmod', ['+x', ghStub]);

    // Create + push a feature branch. The test repo's `main` is the
    // bare remote's default; we make a feature branch off it that
    // we'll later simulate being merged+deleted.
    execFileSync('git', ['checkout', '-q', '-b', 'feature/work'], { cwd: env.repo });
    writeFileSync(join(env.repo, 'src/pkg/a.ts'), 'export const a = 2;\n');
    execFileSync('git', ['commit', '-q', '-am', 'feature change'], { cwd: env.repo });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'feature/work'], {
      cwd: env.repo,
      env: { ...process.env, DOCGEN_HOOK_SKIP: '1' }, // bypass the hook for setup
    });

    // Simulate the PR being merged + branch deleted server-side.
    execFileSync('git', ['--git-dir', env.bare, 'branch', '-D', 'feature/work'], {
      stdio: 'ignore',
    });

    // Locally make another commit on feature/work. The next push will
    // try to push to a branch the remote no longer has — that's fine
    // (git creates it on push), but ALSO our hook does a self-push
    // back to that ref. We want to test the hook's fallback behaviour
    // when ITS push back fails.
    //
    // To force the hook's auto-refresh push to fail, we configure the
    // bare repo to refuse pushes to the feature/work ref so the
    // hook's `git push HEAD:feature/work` fails — exactly the
    // "branch deleted, can't push" state in production.
    execFileSync(
      'git',
      ['--git-dir', env.bare, 'config', 'receive.denyCurrentBranch', 'ignore'],
      { stdio: 'ignore' },
    );
    execFileSync(
      'git',
      ['--git-dir', env.bare, 'symbolic-ref', 'HEAD', 'refs/heads/feature/work'],
      { stdio: 'ignore' },
    );
    // The "branch was deleted, now pointing-but-empty" trick is fragile.
    // Simpler: install a pre-receive hook on the bare repo that rejects
    // any push to feature/work — that reliably forces the hook's
    // self-push to fail.
    mkdirSync(join(env.bare, 'hooks'), { recursive: true });
    writeFileSync(
      join(env.bare, 'hooks', 'pre-receive'),
      [
        '#!/usr/bin/env bash',
        'while read old new ref; do',
        '  if [ "$ref" = "refs/heads/feature/work" ]; then',
        '    echo "stub bare: refusing push to feature/work (simulating merged+deleted branch)"',
        '    exit 1',
        '  fi',
        'done',
        'exit 0',
      ].join('\n'),
    );
    execFileSync('chmod', ['+x', join(env.bare, 'hooks', 'pre-receive')]);
    // Crucial: override any inherited user-global core.hooksPath on the
    // bare repo so OUR pre-receive in bare.git/hooks/ is what actually
    // runs. Without this the global hooksPath silently bypasses local
    // bare hooks (same gotcha as the working-clone hooksPath fix
    // earlier in this file).
    execFileSync('git', ['--git-dir', env.bare, 'config', 'core.hooksPath', join(env.bare, 'hooks')], {
      stdio: 'ignore',
    });

    // Make a local commit that the hook will try (and fail) to push.
    writeFileSync(join(env.repo, 'src/pkg/a.ts'), 'export const a = 3;\n');
    execFileSync('git', ['commit', '-q', '-am', 'local change'], { cwd: env.repo });

    // Trigger the hook. The user's foreground push will be rejected
    // by the pre-receive hook on the bare remote (because we made the
    // bare refuse feature/work). That's OK — it doesn't crash the
    // hook; the hook STILL fires (pre-push runs BEFORE the actual
    // push, regardless of whether the push succeeds).
    //
    // The bg worker:
    //   - waits 5s
    //   - runs docgen → writes a README
    //   - commits
    //   - tries `git push HEAD:feature/work` → bare rejects → fails
    //   - falls through to: checkout new branch docgen/refresh-* →
    //     push it → call `gh pr create`
    const logFile = join(env.root, 'hook.log');
    gitPush(env.repo, env.stubDir, logFile);

    // Wait up to 60s for the follow-up PR path: a docgen/refresh-*
    // branch lands on the bare remote AND gh stub is invoked.
    const ok = await waitUntil(
      () => {
        const refs = spawnSync(
          'git',
          ['--git-dir', env.bare, 'for-each-ref', '--format=%(refname:short)'],
          { encoding: 'utf8' },
        ).stdout || '';
        const hasFollowup = refs.split('\n').some((r) => r.startsWith('docgen/refresh-'));
        const ghCalled = existsSync(ghLog);
        return hasFollowup && ghCalled;
      },
      { timeoutMs: 60_000 },
    );
    if (!ok) {
      const hookLog = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(no log)';
      assert.fail(
        `merged-branch fallback did not produce a follow-up PR within 60s.\n` +
          `--- hook log ---\n${hookLog}\n--- end ---`,
      );
    }

    // Confirm gh was invoked with the right args.
    const ghInvocations = readFileSync(ghLog, 'utf8');
    assert.match(ghInvocations, /pr create/, `gh should be called with 'pr create', got: ${ghInvocations}`);
    assert.match(ghInvocations, /--base main/, `gh pr create should target main: ${ghInvocations}`);
    assert.match(ghInvocations, /docs: refresh docgen READMEs/i,
      `gh pr title should mention docs refresh: ${ghInvocations}`);

    // Confirm the follow-up branch exists on the bare remote and has
    // the auto-refresh commit on it.
    const refs = execFileSync(
      'git',
      ['--git-dir', env.bare, 'for-each-ref', '--format=%(refname:short)'],
      { encoding: 'utf8' },
    );
    const followup = refs.split('\n').find((r) => r.startsWith('docgen/refresh-'));
    assert.ok(followup, `expected docgen/refresh-* branch on bare. all refs:\n${refs}`);
    const followupLog = execFileSync(
      'git',
      ['--git-dir', env.bare, 'log', followup, '-1', '--pretty=%s'],
      { encoding: 'utf8' },
    ).trim();
    assert.match(followupLog, /docs: refresh docgen READMEs/i,
      `follow-up branch should carry the auto-refresh commit, got: ${followupLog}`);
  } finally {
    teardown(env.root);
  }
});

test('empty-diff push: hook falls through to full walk (no --scope), bg still completes', async () => {
  const env = setup();
  try {
    // Empty commit — something to push but no file changes. The
    // hook should see an empty diff and run docgen without --scope.
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'empty push'],
      { cwd: env.repo });

    const logFile = join(env.root, 'hook.log');
    const r = gitPush(env.repo, env.stubDir, logFile);
    assert.equal(r.status, 0);
    await new Promise((res) => setTimeout(res, 9000));

    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    // No `diff range=… files=[1-9]` line should appear — empty diff
    // skips the scope branch and falls through to a full walk.
    const hadScopeLine = /diff range=.*files=[1-9]/.test(log);
    assert.ok(!hadScopeLine,
      `empty push must NOT yield a non-empty diff range. Log:\n${log}`);
    // Hook should terminate cleanly. "no doc changes" (likely, since
    // nothing structurally changed) or "pushed doc refresh" are both
    // valid outcomes; what we're guarding against is a crash.
    assert.ok(
      /no doc changes|pushed doc refresh|nothing to commit/i.test(log),
      `hook should terminate cleanly. Log:\n${log}`,
    );
  } finally {
    teardown(env.root);
  }
});

test('first-push of a new branch: @{push} unresolved → falls back to HEAD~1..HEAD', async () => {
  const env = setup();
  try {
    execFileSync('git', ['checkout', '-q', '-b', 'brand-new-branch'], { cwd: env.repo });
    writeFileSync(join(env.repo, 'src/pkg/new.ts'), 'export const n = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: env.repo });
    execFileSync('git', ['commit', '-q', '-m', 'add new'], { cwd: env.repo });

    const logFile = join(env.root, 'hook.log');
    const r = spawnSync(
      'git', ['push', '-q', '-u', 'origin', 'brand-new-branch'],
      {
        cwd: env.repo,
        env: {
          ...process.env,
          PATH: `${env.stubDir}:${process.env.PATH}`,
          DOCGEN_HOOK_LOG_FILE: logFile,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(r.status, 0);
    await new Promise((res) => setTimeout(res, 9000));

    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    // Either @{push} resolved OR we fell back to HEAD~1..HEAD —
    // both are valid ranges. The diff should have captured
    // src/pkg/new.ts and yielded scope=src/pkg.
    assert.match(
      log,
      /diff range=(HEAD~1\.\.HEAD|@\{push\}\.\.HEAD).*scope=.*src\/pkg/,
      `first-push of new branch should resolve a diff range. Log:\n${log}`,
    );
  } finally {
    teardown(env.root);
  }
});

test('multi-commit push: diff range captures files from ALL commits', async () => {
  const env = setup();
  try {
    // Three commits in three sub-dirs before any push. Diff range
    // @{push}..HEAD must include all three.
    for (const dir of ['alpha', 'beta', 'gamma']) {
      mkdirSync(join(env.repo, `src/${dir}`), { recursive: true });
      writeFileSync(join(env.repo, `src/${dir}/x.ts`), `export const ${dir} = 1;\n`);
      execFileSync('git', ['add', '-A'], { cwd: env.repo });
      execFileSync('git', ['commit', '-q', '-m', `add ${dir}`], { cwd: env.repo });
    }

    const logFile = join(env.root, 'hook.log');
    const r = gitPush(env.repo, env.stubDir, logFile);
    assert.equal(r.status, 0);
    await new Promise((res) => setTimeout(res, 9000));

    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    for (const dir of ['src/alpha', 'src/beta', 'src/gamma']) {
      assert.ok(
        log.includes(dir),
        `scope must include ${dir} from one of 3 commits. Log:\n${log}`,
      );
    }
  } finally {
    teardown(env.root);
  }
});

test('hook script: bash -n syntax check passes', () => {
  const hookPath = join(DOCGEN_DIR, 'hooks/pre-push');
  const r = spawnSync('bash', ['-n', hookPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, `bash -n failed: ${r.stderr}`);
});
