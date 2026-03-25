#!/usr/bin/env python3
"""Launches Xcode with the best project file found in a worktree.

Usage: xcode-launch.py <worktree-path>

Searches for .xcworkspace (preferred) or .xcodeproj files up to 2 levels deep,
skipping Pods and SPM build directories. Falls back to opening the directory.
"""
import os
import subprocess
import sys


def find_project_file(base_path):
    """Find the best Xcode project file in the worktree.

    Priority: .xcworkspace > .xcodeproj (both searched up to depth 2).
    Skips Pods/, .build/, and xcodeproj-embedded workspaces.
    """
    skip_dirs = {"Pods", ".build", "DerivedData", ".swiftpm"}

    for ext in (".xcworkspace", ".xcodeproj"):
        for depth in range(3):  # 0, 1, 2 levels deep
            if depth == 0:
                dirs_to_check = [base_path]
            else:
                dirs_to_check = []
                for root, dirs, _files in os.walk(base_path):
                    # Calculate current depth
                    rel = os.path.relpath(root, base_path)
                    current_depth = 0 if rel == "." else rel.count(os.sep) + 1
                    if current_depth >= depth:
                        dirs.clear()
                        continue
                    # Prune unwanted directories
                    dirs[:] = [
                        d
                        for d in dirs
                        if d not in skip_dirs and not d.endswith(".xcodeproj")
                    ]
                    if current_depth == depth - 1:
                        dirs_to_check.append(root)

            for dir_path in dirs_to_check:
                try:
                    entries = os.listdir(dir_path)
                except OSError:
                    continue
                matches = sorted(e for e in entries if e.endswith(ext))
                for match in matches:
                    full = os.path.join(dir_path, match)
                    # Skip workspaces embedded inside .xcodeproj bundles
                    if ext == ".xcworkspace" and ".xcodeproj" in dir_path:
                        continue
                    return full
    return None


def main():
    if len(sys.argv) < 2:
        print("Usage: xcode-launch.py <worktree-path>", file=sys.stderr)
        sys.exit(1)

    worktree_path = sys.argv[1]
    project_file = find_project_file(worktree_path)
    target = project_file if project_file else worktree_path

    subprocess.run(["open", "-a", "Xcode", target], check=True)


if __name__ == "__main__":
    main()
