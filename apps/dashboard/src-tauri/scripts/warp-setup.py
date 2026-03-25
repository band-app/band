#!/usr/bin/env python3
"""Configures a Warp terminal window with a working directory and commands.

Usage: warp-setup.py <worktree_path> <folder_name>

Reads BAND_CONFIG env var (JSON) to extract commands[].command.
Uses System Events keystrokes to drive the Warp terminal since
Warp does not expose an app-specific AppleScript API.
"""
import json
import os
import subprocess
import sys
import time


def as_escape(s):
    """Escape a value for use inside an AppleScript double-quoted string."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def keystroke_lines(text):
    """Generate AppleScript lines to type text and press Enter via System Events."""
    return [
        f'        keystroke "{as_escape(text)}"',
        '        key code 36',  # Return key
    ]


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

    # Small delay to let the window finish appearing
    time.sleep(0.3)

    lines = [
        'tell application "System Events"',
        '    tell process "Warp"',
        '        set frontmost to true',
    ]

    # Set terminal title via OSC escape sequence
    lines.extend(keystroke_lines(f"printf '\\033]0;{window_name}\\007'"))
    # cd into worktree
    lines.extend(keystroke_lines(f"cd {worktree_path}"))

    # Run commands
    for cmd in commands:
        lines.extend(keystroke_lines(cmd))

    lines.append("    end tell")
    lines.append("end tell")

    script = "\n".join(lines)
    subprocess.run(["osascript", "-e", script], check=True)


if __name__ == "__main__":
    main()
