#!/usr/bin/env bash
# Install (or uninstall) the docgen pre-push hook for THIS git repo
# only. Never edits any machine-global hooks setup.
#
# After install, every `git push` from this clone spawns a detached
# background runner that refreshes docgen READMEs and pushes them back.
# Loop-safe via DOCGEN_HOOK_SKIP=1.
#
#   ./install-push-hook.sh            install
#   ./install-push-hook.sh uninstall  remove
#   ./install-push-hook.sh status     show install state
#
# Install model: the installed file in `.git/hooks/pre-push` (or
# wherever `core.hooksPath` points) is a tiny SHIM that exec's back to
# this repo's source hook at `<claude-code-auto-documentation>/hooks/pre-push`. The
# source hook locates `docgen` via $BASH_SOURCE → sibling, so it works
# regardless of how claude-code-auto-documentation was vendored into the target repo.
#
# Coexistence: if `core.hooksPath` is already set (e.g. by another
# tool like secret-scrub), we install our pre-push into THAT same dir
# alongside the existing pre-commit, so both tools can coexist.

set -euo pipefail

# Resolve our own location. We're at <claude-code-auto-documentation>/install-push-hook.sh.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_HOOK="$SELF/hooks/pre-push"

if [ ! -x "$SOURCE_HOOK" ]; then
  echo "error: source hook not found / not executable at $SOURCE_HOOK" >&2
  echo "Are you running this script from a corrupt claude-code-auto-documentation checkout?" >&2
  exit 1
fi

GIT_ROOT="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
cd "$GIT_ROOT"
HOOKS_PATH="$(git config core.hooksPath || echo '')"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
info() { printf '  • %s\n' "$*"; }

# Where would we install?
install_target() {
  if [ -n "$HOOKS_PATH" ]; then
    printf '%s/pre-push' "$HOOKS_PATH"
  else
    printf '.git/hooks/pre-push'
  fi
}

# Write a SHIM that delegates to our source hook. The shim is what
# gets installed at .git/hooks/pre-push; the source hook (with its
# real logic) stays in this repo. This way:
#   - Updates to the source hook take effect immediately (no re-install)
#   - The shim is trivial — easy to inspect, easy to remove
#   - BASH_SOURCE in the source hook resolves to its real path, so
#     sibling-lookup of `docgen` works
write_shim() {
  local dest="$1"
  cat > "$dest" <<EOF
#!/usr/bin/env bash
# DOCGEN_PRE_PUSH_HOOK_v1 shim — managed by claude-code-auto-documentation.
# This shim was installed by:
#   $SELF/install-push-hook.sh
# Real hook logic lives in:
#   $SOURCE_HOOK
# To uninstall: ./install-push-hook.sh uninstall
exec "$SOURCE_HOOK" "\$@"
EOF
  chmod +x "$dest"
}

install() {
  local dest
  dest="$(install_target)"

  # If something already lives there and isn't ours, refuse.
  if [ -f "$dest" ] && ! grep -q 'DOCGEN_PRE_PUSH_HOOK_v1' "$dest" 2>/dev/null; then
    warn "$dest already exists and isn't ours — refusing to overwrite."
    info "remove or back it up, then re-run install."
    return 1
  fi

  mkdir -p "$(dirname "$dest")"
  write_shim "$dest"
  ok "installed docgen pre-push shim → $dest"
  info "(shim exec's $SOURCE_HOOK)"
  if [ -n "$HOOKS_PATH" ]; then
    info "your repo uses core.hooksPath=$HOOKS_PATH — installed alongside existing hooks."
  fi
  info "every \`git push\` from this clone will spawn a background docgen refresh."
  info "follow it live with: tail -F /tmp/docgen-push-hook.log"
  info "uninstall any time with: $0 uninstall"
}

uninstall() {
  local dest
  dest="$(install_target)"
  if [ -f "$dest" ] && grep -q 'DOCGEN_PRE_PUSH_HOOK_v1' "$dest" 2>/dev/null; then
    rm -f "$dest"
    ok "removed docgen pre-push shim from $dest"
  else
    info "no docgen hook found at $dest — nothing to remove."
  fi
}

status() {
  local dest
  dest="$(install_target)"
  if [ -f "$dest" ] && grep -q 'DOCGEN_PRE_PUSH_HOOK_v1' "$dest" 2>/dev/null; then
    ok "installed at $dest"
    info "shim targets: $SOURCE_HOOK"
  else
    info "not installed (target would be $dest)"
  fi
  if [ -f /tmp/docgen-push-hook.log ]; then
    info "last 5 log lines from /tmp/docgen-push-hook.log:"
    tail -n 5 /tmp/docgen-push-hook.log | sed 's/^/    /'
  fi
}

# ─── auto-wire .claude/settings.json (progressive disclosure + self-heal) ───
# Idempotently add two hooks to the consumer repo's .claude/settings.json:
#   • PreToolUse  -> inject-readme-context.mjs : feeds per-directory READMEs
#     into Claude's context when it Reads/Edits/etc a file (progressive
#     disclosure — the docs always make it in, scoped to where Claude works).
#   • SessionStart -> re-install the push hook each session (self-healing,
#     since the installed git hook is untracked and can go missing).
# Paths are computed relative to the git root, so this works no matter where
# the tool is vendored. Never clobbers existing hooks; safe to re-run.
wire_settings() {
  local rel prefix inject_cmd install_cmd
  if [ "$SELF" = "$GIT_ROOT" ]; then rel=""; else rel="${SELF#$GIT_ROOT/}"; fi
  if [ -n "$rel" ]; then prefix="$rel/"; else prefix=""; fi
  inject_cmd="node ${prefix}inject-readme-context.mjs"
  install_cmd="bash ${prefix}install-push-hook.sh install >/dev/null 2>&1 || true"
  python3 - "$inject_cmd" "$install_cmd" <<'PY'
import json, os, sys
inject_cmd, install_cmd = sys.argv[1], sys.argv[2]
p = ".claude/settings.json"
os.makedirs(".claude", exist_ok=True)
try:
    with open(p) as f:
        data = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    data = {}
hooks = data.setdefault("hooks", {})
def has(event, cmd):
    return any(h.get("command") == cmd
              for g in hooks.get(event, []) for h in g.get("hooks", []))
changed = []
if not has("PreToolUse", inject_cmd):
    hooks.setdefault("PreToolUse", []).append(
        {"matcher": "Read|Edit|Write|Glob|Grep",
         "hooks": [{"type": "command", "command": inject_cmd}]})
    changed.append("PreToolUse")
if not has("SessionStart", install_cmd):
    hooks.setdefault("SessionStart", []).append(
        {"hooks": [{"type": "command", "command": install_cmd}]})
    changed.append("SessionStart")
if changed:
    with open(p, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("WIRED " + " ".join(changed))
else:
    print("ALREADY-WIRED")
PY
}

setup() {
  install || warn "push-hook install skipped (see above) — wiring context injection anyway."
  echo
  info "wiring progressive-disclosure inject hook + SessionStart self-install into .claude/settings.json…"
  local res; res="$(wire_settings)"
  case "$res" in
    WIRED*)        ok "settings.json updated: ${res#WIRED }" ;;
    ALREADY-WIRED) info "settings.json already wired — nothing to add." ;;
    *)             warn "settings.json wiring result: $res" ;;
  esac
  ok "setup complete — docs auto-refresh on push AND inject into Claude's context on file access."
}

case "${1:-install}" in
  install)   install || exit 1 ;;
  uninstall) uninstall ;;
  status)    status ;;
  setup)     setup ;;
  *) echo "usage: $0 [install|uninstall|status|setup]" >&2; exit 1 ;;
esac
