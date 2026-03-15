# hermilinChat video helpers (banner patch + demo history)

This folder contains the assets for hermilinChat’s “video mode” Hermes banner patch.

Goal: make recorded terminal footage look clean and non-sensitive (no model/cwd/session identifiers on screen), while keeping your selected Hermes skin ASCII art.

Nothing here changes Hermes upstream. The patch is applied ONLY to a local Hermes installation on the machine you run the installer on.


## What’s in here

- `banner_fake.json`
  Sample “fake” Tools/Skills list for the Hermes welcome banner.

Related scripts (in `scripts/`):

- `install_hermes_banner_video_patch.py`
  Installs the patch into the target Hermes install.

- `uninstall_hermes_banner_video_patch.py`
  Removes the patch from the target Hermes install.

- `seed_video_history.py`
  Wipes + seeds the hermilinChat sidebar/session history for demos (with automatic backups + restore).


## 1) Hermes banner “video mode” patch

### What it changes

When installed, the patch modifies the Hermes install so the startup/welcome banner:

- hides the “Model”, “CWD”, and “Session” lines under the caduceus (cleaner + no identifiers)
- optionally replaces the Tools/Skills list with a user-provided JSON file (so you can show a curated list on camera)
- preserves the active skin’s banner art (it copies `banner_logo` / `banner_hero` from the current skin so Matrix/etc skins still render)

Implementation detail (for future debugging):
- Hermes v0.2.0 has a project-root `cli.py` that defines its own `build_welcome_banner()`, which shadows `hermes_cli/banner.py`.
- The installer therefore patches BOTH `hermes_cli/banner.py` and the Hermes project-root `cli.py`.


### Install

From the hermilinChat repo:

  python3 scripts/install_hermes_banner_video_patch.py

If you have more than one `hermes` on PATH, explicitly target the one hermilinChat uses:

  python3 scripts/install_hermes_banner_video_patch.py --hermes-exe /full/path/to/hermes

Notes:
- The installer is idempotent: you can safely re-run it; it removes old hermilinChat patch blocks and re-applies the latest version.
- After running `hermes update` (or otherwise upgrading Hermes), you’ll usually need to re-run the installer because the modified files may be overwritten.


### Optional: fake Tools/Skills list

1) Copy the sample JSON into your Hermes home and edit it:

  cp scripts/hermes_banner_video_patch/banner_fake.json ~/.hermes/banner_fake.json
  $EDITOR ~/.hermes/banner_fake.json

2) Point Hermes at it:

  export HERMES_BANNER_FAKE_FILE=~/.hermes/banner_fake.json

You can put that export in `~/.hermes/.env` if you want it to persist.

Optional (some patch versions / setups): explicit hide toggles

The patch is intended to hide these lines automatically when installed, but if you ever need to force the behavior via env vars:

  export HERMES_BANNER_HIDE_MODEL=1
  export HERMES_BANNER_HIDE_CWD=1
  export HERMES_BANNER_HIDE_SESSION=1

JSON format:
- A single JSON object (dictionary/map)
- Keys are group names (you can prefix with `01_`, `02_`, … to force a specific display order)
- Values are arrays/lists of strings


### Uninstall

  python3 scripts/uninstall_hermes_banner_video_patch.py

Or target a specific Hermes binary:

  python3 scripts/uninstall_hermes_banner_video_patch.py --hermes-exe /full/path/to/hermes


## 2) Re-seed demo history (sidebar) for recording

Use `scripts/seed_video_history.py` when you need the hermilinChat sidebar to show a clean, curated “past sessions” list for video.

WARNING: this is destructive (it deletes all sessions + messages from `state.db`) — but it ALWAYS creates a backup first and prints a restore command.

What it touches (inside the Hermes HOME used by hermilinChat):
- `$HERMES_HOME/state.db` (and `state.db-wal` / `state.db-shm` if present)
- hermilinChat meta DB for titles (defaults to `$HERMES_HOME/hermilin_meta.db`)

Backups are saved to:
- `$HERMES_HOME/backups/video-history/<timestamp>/` (includes a `manifest.json`)


### Seed (typical)

  cd /path/to/hermilinChat
  ./.venv/bin/python scripts/seed_video_history.py --env-file .hermelin.env

Then restart hermilinChat.


### Restore the most recent backup

  cd /path/to/hermilinChat
  ./.venv/bin/python scripts/seed_video_history.py --env-file .hermelin.env --restore


### Useful flags

- `--count N`                     number of synthetic sessions
- `--titles-file /path/to/titles.txt`   one title per line (comments with `#` allowed)
- `--seed-whispers`               also seed `ui_whispers` (video-seed source)
- `--dry-run`                     print actions without modifying anything
- `--hermes-home ...` / `--meta-db ...` override paths (otherwise uses `.hermelin.env`)
- `--backup-id ... --restore`     restore a specific backup folder

Tip: stop hermilinChat (and any running Hermes CLI instances) before seeding/restoring so SQLite/WAL files aren’t locked.
