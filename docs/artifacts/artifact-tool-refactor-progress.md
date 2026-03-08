# Artifact Tool Refactor — Progress

This file tracks execution of: `docs/artifacts/artifact-tool-refactor.md`.

Last updated: 2026-03-08 (Step 1 complete)

## Checklist

- [x] Step 1: Rename and restructure the tool file
- [ ] Step 2: Set up the runtime directory structure
- [ ] Step 3: Implement create_artifact
- [ ] Step 4: Implement remove_artifact
- [ ] Step 5: Implement clear_artifacts
- [ ] Step 6: Implement stop_runner
- [ ] Step 7: Write the tool schemas
- [ ] Step 8: Register all four tools
- [ ] Step 9: Update hermilinChat backend
- [ ] Step 10: Clean up the panel header UI
- [ ] Step 11: Upgrade the markdown renderer
- [ ] Step 12: Verify everything works

## Notes / Decisions

Step 1 changes:
- Patch asset renamed: `scripts/hermes_artifact_patch/render_panel_tool.py` -> `scripts/hermes_artifact_patch/artifact_tool.py`
- Installer/uninstaller now patch `model_tools.py` import: `tools.render_panel_tool` -> `tools.artifact_tool`
- `ui_panel` toolset upgraded to new tool names: `create_artifact`, `remove_artifact`, `clear_artifacts`, `stop_runner`
- README + examples updated to mention `create_artifact` + `artifact_tool.py`

- (pending) Toolset name migration plan: currently `ui_panel`; later rename to `artifacts` per Step 8.
- (pending) Backward compatibility: whether to keep a shim for `render_panel`/`close_panel`.
