from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts" / "hermelinfleet-api-v1.json"
TYPES = ROOT / "frontend" / "src" / "types" / "index.ts"


def _interface_fields(source: str, name: str) -> set[str]:
    match = re.search(rf"export interface {re.escape(name)}\s*\{{(?P<body>.*?)\n\}}", source, re.DOTALL)
    assert match, f"missing TypeScript interface {name}"
    return set(re.findall(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:", match.group("body"), re.MULTILINE))


def test_fleet_v1_contract_fixture_matches_browser_types() -> None:
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    assert contract["contract_id"] == "hermelinfleet-api-v1-2026-07-11"
    assert contract["api_prefix"] == "/api/v1"

    source = TYPES.read_text(encoding="utf-8")
    interfaces = {
        "status": "FleetStatusSummary",
        "node": "FleetNode",
        "agent": "FleetAgent",
        "session": "FleetSession",
        "capabilities": "FleetCapabilities",
        "runtime": "HermesRuntime",
    }
    for object_name, interface_name in interfaces.items():
        fields = _interface_fields(source, interface_name)
        missing = set(contract["required_fields"][object_name]) - fields
        assert not missing, f"{interface_name} is missing contract fields: {sorted(missing)}"


def test_fleet_v1_contract_contains_only_same_origin_attach_path() -> None:
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    attach = contract["endpoints"]["runtime_attach"]
    ticket = contract["endpoints"]["runtime_attach_ticket"]
    assert attach.startswith("GET /api/v1/")
    assert ticket.startswith("POST /api/v1/") and ticket.endswith("/attach-ticket")
    assert "://" not in attach
    assert "attach_ws_url" not in contract["required_fields"]["runtime"]
    assert "attach_ws_path" in contract["required_fields"]["runtime"]
