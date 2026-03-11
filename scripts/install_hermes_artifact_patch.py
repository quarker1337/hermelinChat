#!/usr/bin/env python3
"""Deprecated.

hermilinChat no longer patches files inside the Hermes Agent installation.
Artifact Panel tools are loaded at runtime by hermilinChat via:
  scripts/hermes_with_addons.py

This script remains for backward compatibility so older update workflows
don't fail, but it is now a no-op.
"""

def main() -> int:
    print("NOTE: Deprecated: hermilinChat no longer patches Hermes installation for artifact tools.")
    print("      Artifact tools are loaded at runtime by hermilinChat.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
