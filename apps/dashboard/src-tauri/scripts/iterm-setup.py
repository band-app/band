#!/usr/bin/env python3
"""Configures an iTerm2 window with terminal splits and commands.

Usage: iterm-setup.py <worktree_path> <folder_name>

Reads BAND_CONFIG env var (JSON) to extract commands[].command.
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
    splits = [c.get("split", "vertical") for c in raw_commands]

    window_name = f"band:{folder_name}"

    # Variable declarations
    lines = [
        f'set windowName to "{as_escape(window_name)}"',
        f'set worktreePath to "{as_escape(worktree_path)}"',
    ]
    for i, cmd in enumerate(commands):
        lines.append(f'set cmd{i + 1} to "{as_escape(cmd)}"')

    # Main body
    lines.append('tell application "iTerm2"')
    lines.append("    set targetWindow to current window")
    lines.append("    if targetWindow is missing value then return")
    lines.append("    tell targetWindow")
    lines.append("        tell current session of current tab")
    lines.append("            set name to windowName")
    lines.append('            write text "cd " & quoted form of worktreePath')

    # First command in first session
    if commands:
        lines.append("            write text cmd1")

    lines.append("        end tell")

    # Additional commands split based on config (vertical=columns, horizontal=rows)
    for i in range(1, len(commands)):
        direction = splits[i]
        # iTerm AppleScript: "split vertically" = side-by-side columns,
        # "split horizontally" = stacked rows
        iterm_split = "vertically" if direction == "vertical" else "horizontally"
        lines.append("        tell current session of current tab")
        lines.append(f"            set newSession to (split {iterm_split} with default profile)")
        lines.append("            tell newSession")
        lines.append("                set name to windowName")
        lines.append('                write text "cd " & quoted form of worktreePath')
        lines.append(f"                write text cmd{i + 1}")
        lines.append("            end tell")
        lines.append("        end tell")

    lines.append("    end tell")
    lines.append("end tell")

    script = "\n".join(lines)
    subprocess.run(["osascript", "-e", script], check=True)


if __name__ == "__main__":
    main()
