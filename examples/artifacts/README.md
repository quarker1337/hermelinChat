# Artifact panel examples

These files are here so you can demo / validate the artifact panel without creating ad-hoc scripts inside `scripts/` (which can block `./scripts/update.sh`).

HermelinChat renders artifacts from:
- `~/.hermes/artifacts/session/*.json`
- `~/.hermes/artifacts/persistent/*.json`

(And it still supports legacy root-level `~/.hermes/artifacts/*.json`.)

Two ways to create artifacts:

1) Preferred: ask Hermes to call the `create_artifact` tool (toolset: `artifacts`).
   - `create_artifact` writes the JSON artifact files for you.
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

Live runner note

If you use `start_runner(tab_id=...)` to run a background updater, the runner must write the FULL artifact envelope (id/type/title/data/...) to:
- `~/.hermes/artifacts/session/{tab_id}.json` (or `persistent/` if you chose persistent=true)

Common mistake: writing only the payload (e.g. `{ "lines": [...] }`) instead of wrapping it under `data`.

Minimal live artifact JSON file shape:

```json
{
  "id": "demo_logs",
  "type": "logs",
  "title": "Demo logs",
  "data": { "lines": [] },
  "live": true,
  "refresh_seconds": 2,
  "timestamp": 0
}
```
