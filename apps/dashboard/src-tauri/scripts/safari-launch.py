#!/usr/bin/env python3
"""Launches Safari with a URL.

Usage: safari-launch.py

Reads BAND_CONFIG env var (JSON) to extract url (defaults to about:blank).
"""
import json
import os
import subprocess


def main():
    config = json.loads(os.environ.get("BAND_CONFIG", "{}"))
    url = config.get("url", "about:blank") or "about:blank"

    subprocess.run(
        ["open", "-a", "Safari", url],
        check=True,
    )


if __name__ == "__main__":
    main()
