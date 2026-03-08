# Artifact Tool Refactor — Progress

This file tracks execution of: `docs/artifacts/artifact-tool-refactor.md`.

Last updated: 2026-03-08 (Steps 10-11 complete)

## Checklist

- [x] Step 1: Rename and restructure the tool file
- [x] Step 2: Set up the runtime directory structure
- [x] Step 3: Implement create_artifact
- [x] Step 4: Implement remove_artifact
- [x] Step 5: Implement clear_artifacts
- [x] Step 6: Implement stop_runner
- [x] Step 7: Write the tool schemas
- [x] Step 8: Register all four tools
- [x] Step 9: Update hermilinChat backend
- [x] Step 10: Clean up the panel header UI
- [x] Step 11: Upgrade the markdown renderer
- [ ] Step 12: Verify everything works

## Notes / Decisions

Step 1 changes:
- Patch asset renamed: `scripts/hermes_artifact_patch/render_panel_tool.py` -> `scripts/hermes_artifact_patch/artifact_tool.py`
- Installer/uninstaller now patch `model_tools.py` import: `tools.render_panel_tool` -> `tools.artifact_tool`
- Tool names upgraded: `create_artifact`, `remove_artifact`, `clear_artifacts`, `stop_runner` (replacing `render_panel`/`close_panel`)
- README + examples updated to mention `create_artifact` + `artifact_tool.py`

Step 2 changes:
- Defined the runtime directory constants in `artifact_tool.py`:
  - `ARTIFACT_SESSION_DIR`, `ARTIFACT_PERSISTENT_DIR`, `RUNNERS_DIR`, `PIDS_DIR`
- Added `_ensure_dir()` helper using `os.makedirs(..., exist_ok=True)`
- Kept legacy behavior for non-create methods; Step 3 switches create_artifact to session/persistent.

Step 3 changes:
- `create_artifact` now writes `{tab_id}.json` into:
  - `~/.hermes/artifacts/session/` (default)
  - `~/.hermes/artifacts/persistent/` (`persistent=true`)
- `create_artifact` always updates `~/.hermes/artifacts/_latest.json`

Step 4 changes:
- `remove_artifact` now deletes `{tab_id}.json` from BOTH `session/` and `persistent/` dirs
- `remove_artifact` calls `stop_runner(tab_id)` (runner stop is a no-op until Step 6)

Step 5 changes:
- `clear_artifacts(scope=...)` now deletes artifacts from the correct scope directories:
  - session -> `~/.hermes/artifacts/session/`
  - persistent -> `~/.hermes/artifacts/persistent/`
  - all -> both
- Stops runners best-effort before deleting files (and for scope=all also tries to stop any remaining PID-tracked runners)
- Writes `~/.hermes/artifacts/_close_signal.json` with action=close_all

Step 6 changes:
- Implemented `stop_runner(tab_id)`:
  - reads PID from `~/.hermes/pids/{tab_id}.pid`
  - sends SIGTERM (best-effort)
  - deletes the PID file
  - deletes the runner script `~/.hermes/runners/{tab_id}_runner.py`

Step 7 changes:
- `CREATE_ARTIFACT_SCHEMA` description now documents the live-runner pattern (runners/ + pids/ + overwrite artifact JSON loop + stop via `stop_runner`).

Step 8 changes:
- Tools now register under toolset: `artifacts`
- Hermes patch installer injects an `artifacts` toolset and makes `ui_panel` a backward-compatible alias (so older configs still work)

Step 9 changes:
- Updated hermilinChat backend artifact helpers (`hermelin/artifacts.py`) to read/merge artifacts from:
  - `~/.hermes/artifacts/session/`
  - `~/.hermes/artifacts/persistent/`
  - (plus legacy root-level `~/.hermes/artifacts/*.json` for backward compatibility)
- Ensures every returned artifact has a correct `persistent: true/false` flag
- De-dupes by `artifact.id` (newest wins; persistent wins ties)

Step 10 changes:
- Artifact panel header simplified:
  - removed the verbose "via … · type · task" metadata row
  - metadata is now available via an ⓘ (info) tooltip in the header
  - added a maximize/restore width toggle
  - empty-state copy now references `create_artifact`
  - footer typography made more subtle

Step 11 changes:
- Markdown artifacts now render via `marked` with fenced-code highlighting via `highlight.js`
- Language support registered: bash, css, go, javascript, json, python, rust, sql, typescript, xml/html, yaml
- Added basic markdown styling for tables, hr, images, and code blocks

- (pending) Backward compatibility: whether to keep a shim for `render_panel`/`close_panel` (tool aliases).
