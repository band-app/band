#!/bin/bash
# Band hook for Claude Code — reports agent status changes
# This script is called by Claude Code lifecycle hooks.
# It derives workspace identity from git and writes status to ~/.band/status/

set -euo pipefail

HOOK_EVENT="${CLAUDE_HOOK_EVENT:-}"
if [ -z "$HOOK_EVENT" ]; then
  exit 0
fi

# Must be in a git repo
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  exit 0
fi

# Derive project name from the main worktree folder
MAIN_WORKTREE=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
if [ -z "$MAIN_WORKTREE" ]; then
  exit 0
fi
PROJECT=$(basename "$MAIN_WORKTREE")

# Branch = workspace ID component
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
if [ -z "$BRANCH" ]; then
  exit 0
fi

WORKSPACE_ID="${PROJECT}-${BRANCH}"
STATUS_DIR="$HOME/.band/status"
STATUS_FILE="$STATUS_DIR/${WORKSPACE_ID}.json"
WORKTREE_PATH=$(pwd)

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
