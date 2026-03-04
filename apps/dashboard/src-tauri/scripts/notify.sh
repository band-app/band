#!/bin/bash
# Band hook for Claude Code — reports agent status changes
# This script is called by Claude Code lifecycle hooks.
# It looks up workspace identity from ~/.band/state.json and writes status to ~/.band/status/

set -euo pipefail

# Read hook input from stdin (Claude Code passes JSON with hook_event_name)
INPUT=$(cat)
HOOK_EVENT=$(echo "$INPUT" | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin).get('hook_event_name',''))" 2>/dev/null || true)
if [ -z "$HOOK_EVENT" ]; then
  exit 0
fi

STATE_FILE="$HOME/.band/state.json"
CURRENT_DIR=$(pwd -P)

# Look up project and branch from state.json (single source of truth)
MATCH=""
if [ -f "$STATE_FILE" ]; then
  MATCH=$(/usr/bin/python3 - "$STATE_FILE" "$CURRENT_DIR" <<'PYEOF'
import json, sys, os
try:
    state = json.load(open(sys.argv[1]))
    cwd = os.path.realpath(sys.argv[2]).rstrip("/")
    for proj in state.get("projects", []):
        for wt in proj.get("worktrees", []):
            wt_path = wt["path"].rstrip("/")
            if cwd == wt_path or cwd.startswith(wt_path + "/"):
                print(proj["name"])
                print(wt["branch"])
                print(wt["path"])
                sys.exit(0)
except Exception:
    pass
sys.exit(1)
PYEOF
  ) || true
fi

if [ -z "$MATCH" ]; then
  exit 0
fi

PROJECT=$(echo "$MATCH" | sed -n '1p')
BRANCH=$(echo "$MATCH" | sed -n '2p')
WORKTREE_PATH=$(echo "$MATCH" | sed -n '3p')

if [ -z "$PROJECT" ] || [ -z "$BRANCH" ]; then
  exit 0
fi

WORKSPACE_ID="${PROJECT}-${BRANCH}"
STATUS_DIR="$HOME/.band/status"
STATUS_FILE="$STATUS_DIR/${WORKSPACE_ID}.json"

# Map hook event to agent status
case "$HOOK_EVENT" in
  UserPromptSubmit|PostToolUse|PostToolUseFailure)
    STATUS="working"
    ;;
  Stop)
    STATUS="needs_attention"
    ;;
  PermissionRequest)
    STATUS="needs_attention"
    ;;
  *)
    exit 0
    ;;
esac

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

mkdir -p "$STATUS_DIR"

if [ -f "$STATUS_FILE" ]; then
  # Atomic update via tmp + mv
  TMP_FILE=$(mktemp "$STATUS_DIR/.tmp.XXXXXX")
  sed -e "s/\"status\": *\"[^\"]*\"/\"status\": \"$STATUS\"/" \
      -e "s/\"lastActivity\": *\"[^\"]*\"/\"lastActivity\": \"$NOW\"/" \
      "$STATUS_FILE" > "$TMP_FILE"
  mv "$TMP_FILE" "$STATUS_FILE"
else
  cat > "$STATUS_FILE" <<EOF
{
  "workspaceId": "$WORKSPACE_ID",
  "project": "$PROJECT",
  "branch": "$BRANCH",
  "worktreePath": "$WORKTREE_PATH",
  "ide": "vscode",
  "agent": {
    "name": "claude-code",
    "status": "$STATUS",
    "lastActivity": "$NOW"
  }
}
EOF
fi
