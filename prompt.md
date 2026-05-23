You are writing a per-directory README.md for an autonomous coding agent
(another instance of you) that will navigate this codebase later. The
goal is to let that future agent answer "what's in this directory and
what does it do" in ONE read, without grepping individual files.

Read everything in the `--- CONTEXT ---` section that follows. It
contains: the directory path, every readable file in that directory,
the parent directory's README (if any) for vocabulary continuity, and
— for "trunk" directories whose children have already been documented
— each immediate sub-directory's README. Trunk directories should
SUMMARIZE their children, not duplicate their detail.

## Required output

### Line 1: version marker (REQUIRED)

The VERY FIRST line of your output must be an HTML comment of the form:

    <!-- docgen:version=X.Y.Z reason: <short justification> -->

Semantics — semver-flavoured, but on documentation, not code:

- **patch** (`0.3.1 → 0.3.2`) — cosmetic: line numbers shifted, file
  renamed but does the same thing, gotcha worded differently. Same
  architecture. The previous README's claims still hold.
- **minor** (`0.3.1 → 0.4.0`) — material: a new file added, a
  responsibility moved in or out, a load-bearing function renamed AND
  its callers should be aware. The previous README would mislead a
  reader in some specific way.
- **major** (`1.0.0`) — the directory's purpose changed, or it was
  restructured top-to-bottom. The previous README is essentially
  obsolete.

If no prior version is shown to you below, start at `0.1.0`.

A docgen post-processor will OVERRIDE your patch decision to minor if
files were added or removed in this directory. Bump honestly; the
override is just a safety net.

### Then the README body

After the version line, write the README with this structure — keep it
tight; an LLM is reading this, not a human looking for marketing copy:

## Purpose
ONE OR TWO sentences. What is this directory's job in the codebase?
Why does it exist? Don't say "this directory contains files about X" —
say "this is the X subsystem; it owns Y."

## Files
A bullet list, one per file, in the form:
- `filename.ext` — one-sentence summary of what this file does and the
  load-bearing functions / exports / responsibilities it owns. Lead
  with the action ("computes", "owns", "wires", "tests"), not the type.

## Subdirectories
ONLY IF immediate sub-directory READMEs are provided to you below
(i.e. this is a trunk dir). One bullet per subdir:
- `subdirname/` — one-line summary derived from its README's Purpose.
  Point to `subdirname/README.md` for detail.
Do NOT repeat the children's file lists or gotchas.

## Dependencies / collaborators
Bullet list of OTHER directories or modules this code reads from or
writes to. Only include load-bearing ones — the next agent needs to
know "to change the thing in this dir, also check X." Skip standard
library / third-party deps unless they shape the architecture.

## Gotchas
Up to 3 bullets ONLY for things that would surprise a new agent — silent
failure modes, env vars that must be set, conventions that look weird
out of context, work that has to happen in a specific order. Omit this
section entirely if there's nothing surprising.

Constraints:
- Output the README content directly. Do NOT wrap it in ``` fences.
- Do NOT include a top-level title — the file path is the title.
- Be specific. "Handles caching" is useless; "in-memory + disk-backed
  TTL cache for Jupiter API responses, 5-min TTL, serves stale on 429"
  is useful.
- Reference real symbols/functions/exports by name where it helps.
- If a file is just a re-export or a barrel, say so in one word and
  move on.
- Skip generated files (lock files, build artifacts) in your prose —
  they're filtered upstream but if any leak through, ignore them.

If the directory's purpose is genuinely unclear from the files
(e.g. mixed dumping ground), say so explicitly. A future agent dealing
with "I scanned this and the purpose is ambiguous" is better off than
one reading made-up confident prose.
