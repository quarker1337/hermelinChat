# Artifact panel examples

These files are here so you can demo / validate the artifact panel without creating ad-hoc scripts inside `scripts/` (which can block `./scripts/update.sh`).

HermilinChat renders artifacts from `~/.hermes/artifacts/*.json`.

Two ways to create artifacts:

1) Preferred: ask Hermes to call the `render_panel` tool (toolset: `ui_panel`).
   - `render_panel` writes the JSON artifact files for you.
   - Reuse the same `tab_id` to update an existing artifact in-place.

2) Manual (debug): write an artifact JSON file directly into `~/.hermes/artifacts/`.
   - Use `payloads.json` in this folder as the `data` section.
   - Minimal artifact file shape:

```json
{
  "id": "demo_table",
  "type": "table",
  "title": "Demo table",
  "data": { "columns": ["a"], "rows": [["b"]] },
  "live": false,
  "refresh_seconds": 0,
  "timestamp": 0
}
```

Payload examples for each artifact type live in `payloads.json`.
