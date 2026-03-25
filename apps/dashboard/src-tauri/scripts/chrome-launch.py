#!/usr/bin/env python3
"""Launches Google Chrome in app mode.

Usage: chrome-launch.py

Reads BAND_CONFIG env var (JSON) to extract url (defaults to about:blank).
"""
import json
import os
import subprocess
import sys


def main():
    config = json.loads(os.environ.get("BAND_CONFIG", "{}"))
    url = config.get("url", "about:blank") or "about:blank"

    subprocess.run(
        ["open", "-na", "Google Chrome", "--args", f"--app={url}"],
        check=True,
    )


if __name__ == "__main__":
    main()
