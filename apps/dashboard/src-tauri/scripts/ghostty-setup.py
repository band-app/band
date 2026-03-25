#!/usr/bin/env python3
"""Configures a Ghostty window with a working directory and commands.

Usage: ghostty-setup.py <worktree_path> <folder_name>

Reads BAND_CONFIG env var (JSON) to extract commands[].command.
Uses Ghostty's AppleScript API to send keystrokes to the terminal.
"""
import json
import os
import subprocess
import sys


def as_escape(s):
    """Escape a value for use inside an AppleScript double-quoted string."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def main():
    worktree_path = sys.argv[1]
    folder_name = sys.argv[2]

    config = json.loads(os.environ.get("BAND_CONFIG", "{}"))
    raw_commands = [
        c for c in config.get("commands", [])
        if isinstance(c, dict) and "command" in c
    ]
    commands = [c["command"] for c in raw_commands]

    window_name = f"band:{folder_name}"

    lines = [
        'tell application "Ghostty"',
        "    set term to focused terminal of selected tab of front window",
        # Set terminal title via OSC escape sequence
        f"    input text \"printf '\\\\033]0;{as_escape(window_name)}\\\\007'\" to term",
        '    send key "enter" to term',
        # cd into worktree
        f"    input text \"cd {as_escape(worktree_path)}\" to term",
        '    send key "enter" to term',
    ]

    for cmd in commands:
        lines.append(f"    input text \"{as_escape(cmd)}\" to term")
        lines.append('    send key "enter" to term')

    lines.append("end tell")

    script = "\n".join(lines)
    subprocess.run(["osascript", "-e", script], check=True)


if __name__ == "__main__":
    main()
