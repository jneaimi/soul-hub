#!/usr/bin/env python3
"""Fix orphan notes in the vault by adding parent wikilinks.

Usage:
    python3 scripts/fix-orphans.py --dry-run    # report only
    python3 scripts/fix-orphans.py --execute    # actually modify files
"""

import argparse
import os
import re
import sys

VAULT_ROOT = os.path.expanduser("~/vault")
SKIP_FILES = {"CLAUDE.md", "index.md"}
WIKILINK_RE = re.compile(r"\[\[.+?\]\]")


def determine_parent_link(rel_path: str) -> str | None:
    """Return a parent wikilink based on the note's path."""
    parts = rel_path.split("/")
    zone = parts[0]

    if zone == "knowledge":
        return "Part of [[knowledge/index|Knowledge]]"
    elif zone == "content":
        if len(parts) >= 2 and parts[1] == "signal-forge":
            return "Part of [[content/signal-forge/index|Signal Forge]]"
        return "Part of [[content/index|Content]]"
    elif zone == "projects":
        if len(parts) >= 2:
            project = parts[1]
            return f"Part of [[projects/{project}/index|{project}]]"
        return None
    elif zone == "operations":
        return "Part of [[operations/index|Operations]]"

    return None


def scan_orphans(vault_root: str) -> list[dict]:
    """Scan vault for orphan notes (no wikilinks)."""
    orphans = []
    skip_zones = {"inbox", "archive", ".vault", ".obsidian", ".git", ".trash"}

    for dirpath, dirnames, filenames in os.walk(vault_root):
        # Skip excluded directories
        dirnames[:] = [d for d in dirnames if d not in skip_zones and d != "node_modules"]

        rel_dir = os.path.relpath(dirpath, vault_root)
        if rel_dir == ".":
            # Top-level — only process zone subdirs
            continue

        zone = rel_dir.split("/")[0]
        if zone in skip_zones:
            continue

        for fname in filenames:
            if not fname.endswith(".md"):
                continue
            if fname in SKIP_FILES:
                continue

            abs_path = os.path.join(dirpath, fname)
            rel_path = os.path.relpath(abs_path, vault_root)

            with open(abs_path, "r", encoding="utf-8") as f:
                content = f.read()

            if WIKILINK_RE.search(content):
                continue

            parent_link = determine_parent_link(rel_path)
            if parent_link:
                orphans.append({
                    "path": rel_path,
                    "abs_path": abs_path,
                    "content": content,
                    "parent_link": parent_link,
                })

    return orphans


def fix_orphan(orphan: dict) -> None:
    """Add parent wikilink to an orphan note."""
    content = orphan["content"].rstrip("\n")
    content += f"\n\n{orphan['parent_link']}\n"
    with open(orphan["abs_path"], "w", encoding="utf-8") as f:
        f.write(content)


def main():
    parser = argparse.ArgumentParser(description="Fix orphan notes in the vault")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true", help="Report only, don't modify files")
    group.add_argument("--execute", action="store_true", help="Actually modify files")
    args = parser.parse_args()

    print(f"Scanning vault: {VAULT_ROOT}")
    orphans = scan_orphans(VAULT_ROOT)

    if not orphans:
        print("No orphan notes found.")
        return

    print(f"\nFound {len(orphans)} orphan notes:\n")
    for o in orphans:
        print(f"  {o['path']}")
        print(f"    -> {o['parent_link']}")

    if args.dry_run:
        print(f"\n[DRY RUN] Would fix {len(orphans)} orphan notes.")
        return

    fixed = 0
    for o in orphans:
        try:
            fix_orphan(o)
            fixed += 1
        except Exception as e:
            print(f"  ERROR fixing {o['path']}: {e}", file=sys.stderr)

    print(f"\nFixed {fixed}/{len(orphans)} orphan notes.")


if __name__ == "__main__":
    main()
