"""Pure text-manipulation helpers for editing YAML / CLI config strings.

These functions are stateless: they accept text input and return text output
with no dependency on application state.
"""
from __future__ import annotations

import json
import re
import shlex

import yaml


def _yaml_inline_scalar(value: str) -> str:
    dumped = yaml.safe_dump([value], default_flow_style=True, allow_unicode=True, sort_keys=False).strip()
    if dumped.startswith("[") and dumped.endswith("]"):
        return dumped[1:-1].strip()
    return json.dumps(value, ensure_ascii=False)


def _dump_yaml_mapping(data: dict, newline: str = "\n", trailing_newline: bool = True) -> str:
    out = yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
    if newline != "\n":
        out = out.replace("\n", newline)
    if not trailing_newline:
        out = out.rstrip("\r\n")
    return out


def _normalize_scalar_text(value: object) -> str:
    return str(value or "").strip().lower()


def _update_display_skin_config_text(text: str, skin: str) -> tuple[str, bool]:
    raw = text or ""
    skin = str(skin or "").strip()
    if not skin:
        return raw, False

    newline = "\r\n" if "\r\n" in raw else "\n"
    had_trailing_newline = raw.endswith(("\n", "\r"))
    lines = raw.splitlines()
    scalar = _yaml_inline_scalar(skin)

    def _join(next_lines: list[str]) -> str:
        out = newline.join(next_lines)
        if next_lines and (had_trailing_newline or not raw):
            out += newline
        return out

    for idx, line in enumerate(lines):
        if line[:1].isspace():
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^(display\.skin\s*:\s*)([^#\r\n]*?)(\s*(?:#.*)?)?$", line)
        if not m:
            continue
        updated = f"{m.group(1)}{scalar}{m.group(3) or ''}"
        if updated == line:
            return raw, False
        next_lines = list(lines)
        next_lines[idx] = updated
        return _join(next_lines), True

    for idx, line in enumerate(lines):
        if line[:1].isspace():
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not re.match(r"^display\s*:\s*(?:#.*)?$", stripped):
            continue

        block_end = len(lines)
        for j in range(idx + 1, len(lines)):
            s = lines[j].strip()
            if not s:
                continue
            if not lines[j][:1].isspace():
                block_end = j
                break

        child_indent_len = None
        for j in range(idx + 1, block_end):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len > 0:
                child_indent_len = indent_len
                break
        child_indent_len = child_indent_len or 2
        child_indent = " " * child_indent_len

        for j in range(idx + 1, block_end):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len != child_indent_len:
                continue
            m = re.match(r"^(\s*skin\s*:\s*)([^#\r\n]*?)(\s*(?:#.*)?)?$", lines[j])
            if not m:
                continue
            updated = f"{m.group(1)}{scalar}{m.group(3) or ''}"
            if updated == lines[j]:
                return raw, False
            next_lines = list(lines)
            next_lines[j] = updated
            return _join(next_lines), True

        insert_at = idx + 1
        while insert_at < block_end:
            s = lines[insert_at].strip()
            if not s:
                insert_at += 1
                continue
            indent_len = len(lines[insert_at]) - len(lines[insert_at].lstrip(" "))
            if indent_len > 0 and s.startswith("#"):
                insert_at += 1
                continue
            break

        next_lines = list(lines)
        next_lines.insert(insert_at, f"{child_indent}skin: {scalar}")
        return _join(next_lines), True

    next_lines = list(lines)
    if next_lines and next_lines[-1].strip():
        next_lines.append("")
    next_lines.extend(["display:", f"  skin: {scalar}"])
    return _join(next_lines), True


def _update_dashboard_theme_config_text(text: str, theme: str) -> tuple[str, bool]:
    """Update the effective Hermes Dashboard theme without full YAML rewrite.

    Hermes' dashboard loader reads the nested form (`dashboard: theme:`).  The
    config UI exposes the key as `dashboard.theme`, and older/manual files may
    contain that dotted top-level key, but leaving only the dotted form would be
    ignored by the dashboard runtime.  Prefer the nested block and convert a lone
    dotted key into that effective shape while preserving nearby comments.
    """

    raw = text or ""
    theme = str(theme or "").strip()
    if not theme:
        return raw, False

    newline = "\r\n" if "\r\n" in raw else "\n"
    had_trailing_newline = raw.endswith(("\n", "\r"))
    lines = raw.splitlines()
    scalar = _yaml_inline_scalar(theme)

    def _join(next_lines: list[str]) -> str:
        out = newline.join(next_lines)
        if next_lines and (had_trailing_newline or not raw):
            out += newline
        return out

    # Prefer the nested block because that is what Hermes' dashboard runtime
    # reads after load_config() merges user config with defaults.
    for idx, line in enumerate(lines):
        if line[:1].isspace():
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not re.match(r"^dashboard\s*:\s*(?:#.*)?$", stripped):
            continue

        block_end = len(lines)
        for j in range(idx + 1, len(lines)):
            s = lines[j].strip()
            if not s:
                continue
            if not lines[j][:1].isspace():
                block_end = j
                break

        child_indent_len = None
        for j in range(idx + 1, block_end):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len > 0:
                child_indent_len = indent_len
                break
        child_indent_len = child_indent_len or 2
        child_indent = " " * child_indent_len

        for j in range(idx + 1, block_end):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len != child_indent_len:
                continue
            m = re.match(r"^(\s*theme\s*:\s*)([^#\r\n]*?)(\s*(?:#.*)?)?$", lines[j])
            if not m:
                continue
            updated = f"{m.group(1)}{scalar}{m.group(3) or ''}"
            if updated == lines[j]:
                return raw, False
            next_lines = list(lines)
            next_lines[j] = updated
            return _join(next_lines), True

        insert_at = idx + 1
        while insert_at < block_end:
            s = lines[insert_at].strip()
            if not s:
                insert_at += 1
                continue
            indent_len = len(lines[insert_at]) - len(lines[insert_at].lstrip(" "))
            if indent_len > 0 and s.startswith("#"):
                insert_at += 1
                continue
            break

        next_lines = list(lines)
        next_lines.insert(insert_at, f"{child_indent}theme: {scalar}")
        return _join(next_lines), True

    # Convert a lone dotted key into the nested shape the dashboard actually
    # reads. Preserve an inline comment by moving it to the child value line.
    for idx, line in enumerate(lines):
        if line[:1].isspace():
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^(dashboard\.theme\s*:\s*)([^#\r\n]*?)(\s*(?:#.*)?)?$", line)
        if not m:
            continue
        comment = m.group(3) or ""
        replacement = ["dashboard:", f"  theme: {scalar}{comment}"]
        next_lines = list(lines)
        next_lines[idx : idx + 1] = replacement
        return _join(next_lines), True

    # Avoid appending a duplicate top-level section when the file uses an
    # inline mapping (`dashboard: {theme: old}`). In that uncommon case,
    # preserve semantics over exact formatting.
    try:
        parsed = yaml.safe_load(raw) or {}
    except Exception:
        parsed = {}
    if isinstance(parsed, dict) and isinstance(parsed.get("dashboard"), dict):
        dashboard = parsed.get("dashboard") or {}
        if str(dashboard.get("theme") or "").strip() == theme:
            return raw, False
        next_data = dict(parsed)
        next_dashboard = dict(dashboard)
        next_dashboard["theme"] = theme
        next_data["dashboard"] = next_dashboard
        return _dump_yaml_mapping(next_data, newline, had_trailing_newline or not raw), True

    next_lines = list(lines)
    if next_lines and next_lines[-1].strip():
        next_lines.append("")
    next_lines.extend(["dashboard:", f"  theme: {scalar}"])
    return _join(next_lines), True


def _update_nested_bool_flag_config_text(text: str, path: tuple[str, ...], enabled: bool) -> tuple[str, bool]:
    raw = text or ""
    keys = [str(k or "").strip() for k in path if str(k or "").strip()]
    if not keys:
        return raw, False

    newline = "\r\n" if "\r\n" in raw else "\n"
    had_trailing_newline = raw.endswith(("\n", "\r"))
    lines = raw.splitlines()
    scalar = "true" if enabled else "false"

    def _join(next_lines: list[str]) -> str:
        out = newline.join(next_lines)
        if next_lines and (had_trailing_newline or not raw):
            out += newline
        return out

    dotted_key_re = re.escape(".".join(keys))
    for idx, line in enumerate(lines):
        if line[:1].isspace():
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(rf"^({dotted_key_re}\s*:\s*)([^#\r\n]*?)(\s*(?:#.*)?)?$", line)
        if not m:
            continue
        updated = f"{m.group(1)}{scalar}{m.group(3) or ''}"
        if updated == line:
            return raw, False
        next_lines = list(lines)
        next_lines[idx] = updated
        return _join(next_lines), True

    def _find_block_end(start_idx: int, parent_indent_len: int) -> int:
        end = len(lines)
        for j in range(start_idx + 1, len(lines)):
            s = lines[j].strip()
            if not s:
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len <= parent_indent_len:
                end = j
                break
        return end

    def _first_child_indent(start_idx: int, end_idx: int, parent_indent_len: int) -> int:
        for j in range(start_idx + 1, end_idx):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len > parent_indent_len:
                return indent_len
        return parent_indent_len + 2

    def _find_child_key(parent_idx: int, parent_indent_len: int, key: str) -> tuple[int | None, int, int]:
        end_idx = _find_block_end(parent_idx, parent_indent_len)
        child_indent_len = _first_child_indent(parent_idx, end_idx, parent_indent_len)
        key_re = re.escape(key)
        for j in range(parent_idx + 1, end_idx):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len != child_indent_len:
                continue
            if re.match(rf"^{key_re}\s*:\s*(?:#.*)?$", s):
                return j, child_indent_len, end_idx
        return None, child_indent_len, end_idx

    parent_idx = None
    parent_indent_len = -1
    parent_end = len(lines)

    for depth, key in enumerate(keys[:-1]):
        key_re = re.escape(key)
        found = False
        for idx, line in enumerate(lines if parent_idx is None else lines[parent_idx + 1:parent_end], start=0 if parent_idx is None else parent_idx + 1):
            if line[:1].isspace() and parent_idx is None:
                continue
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(line) - len(line.lstrip(" "))
            if parent_idx is None:
                if indent_len != 0:
                    continue
            else:
                child_indent_len = _first_child_indent(parent_idx, parent_end, parent_indent_len)
                if indent_len != child_indent_len:
                    continue
            if not re.match(rf"^{key_re}\s*:\s*(?:#.*)?$", s):
                continue
            parent_idx = idx
            parent_indent_len = indent_len
            parent_end = _find_block_end(parent_idx, parent_indent_len)
            found = True
            break

        if found:
            continue

        next_lines = list(lines)
        if parent_idx is None:
            if next_lines and next_lines[-1].strip():
                next_lines.append("")
            base_indent = 0
            insert_at = len(next_lines)
        else:
            base_indent = _first_child_indent(parent_idx, parent_end, parent_indent_len)
            insert_at = parent_idx + 1
            while insert_at < parent_end:
                s = next_lines[insert_at].strip()
                if not s:
                    insert_at += 1
                    continue
                indent_len = len(next_lines[insert_at]) - len(next_lines[insert_at].lstrip(" "))
                if indent_len >= base_indent and s.startswith("#"):
                    insert_at += 1
                    continue
                break
        block_lines = []
        current_indent = base_indent
        for rest_key in keys[depth:-1]:
            block_lines.append(f"{' ' * current_indent}{rest_key}:")
            current_indent += 2
        block_lines.append(f"{' ' * current_indent}{keys[-1]}: {scalar}")
        next_lines[insert_at:insert_at] = block_lines
        return _join(next_lines), True

    leaf_key = re.escape(keys[-1])
    if parent_idx is not None:
        leaf_indent_len = _first_child_indent(parent_idx, parent_end, parent_indent_len)
        for j in range(parent_idx + 1, parent_end):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len != leaf_indent_len:
                continue
            m = re.match(rf"^(\s*{leaf_key}\s*:\s*)([^#\r\n]*?)(\s*(?:#.*)?)?$", lines[j])
            if not m:
                continue
            updated = f"{m.group(1)}{scalar}{m.group(3) or ''}"
            if updated == lines[j]:
                return raw, False
            next_lines = list(lines)
            next_lines[j] = updated
            return _join(next_lines), True

        insert_at = parent_idx + 1
        while insert_at < parent_end:
            s = lines[insert_at].strip()
            if not s:
                insert_at += 1
                continue
            indent_len = len(lines[insert_at]) - len(lines[insert_at].lstrip(" "))
            if indent_len > parent_indent_len and s.startswith("#"):
                insert_at += 1
                continue
            break
        next_lines = list(lines)
        next_lines.insert(insert_at, f"{' ' * leaf_indent_len}{keys[-1]}: {scalar}")
        return _join(next_lines), True

    next_lines = list(lines)
    if next_lines and next_lines[-1].strip():
        next_lines.append("")
    current_indent = 0
    for key in keys[:-1]:
        next_lines.append(f"{' ' * current_indent}{key}:")
        current_indent += 2
    next_lines.append(f"{' ' * current_indent}{keys[-1]}: {scalar}")
    return _join(next_lines), True


def _update_default_artifact_flag_config_text(text: str, artifact_id: str, enabled: bool) -> tuple[str, bool]:
    return _update_nested_bool_flag_config_text(text, ("hermelin", "default_artifacts", artifact_id), enabled)


def _update_hermelin_launch_mode_config_text(text: str, mode: str) -> tuple[str, bool]:
    raw = text or ""
    normalized = str(mode or "").strip().lower()
    if normalized not in {"chat", "tui"}:
        normalized = "chat"

    newline = "\r\n" if "\r\n" in raw else "\n"
    had_trailing_newline = raw.endswith(("\n", "\r"))
    lines = raw.splitlines()
    scalar = _yaml_inline_scalar(normalized)
    try:
        parsed = yaml.safe_load(raw) or {}
    except Exception:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    hermelin_cfg = parsed.get("hermelin")
    if "hermelin" in parsed and not isinstance(hermelin_cfg, dict):
        parsed["hermelin"] = {"hermes_launch_mode": normalized}
        return _dump_yaml_mapping(parsed, newline, had_trailing_newline or not raw), True

    def _join(next_lines: list[str]) -> str:
        out = newline.join(next_lines)
        if next_lines and (had_trailing_newline or not raw):
            out += newline
        return out

    for idx, line in enumerate(lines):
        if line[:1].isspace():
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^(hermelin\.hermes_launch_mode\s*:\s*)([^#\r\n]*?)(\s*(?:#.*)?)?$", line)
        if not m:
            continue
        updated = f"{m.group(1)}{scalar}{m.group(3) or ''}"
        if updated == line:
            return raw, False
        next_lines = list(lines)
        next_lines[idx] = updated
        return _join(next_lines), True

    for idx, line in enumerate(lines):
        if line[:1].isspace():
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not re.match(r"^hermelin\s*:\s*(?:#.*)?$", stripped):
            continue

        block_end = len(lines)
        for j in range(idx + 1, len(lines)):
            s = lines[j].strip()
            if not s:
                continue
            if not lines[j][:1].isspace():
                block_end = j
                break

        child_indent_len = None
        for j in range(idx + 1, block_end):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len > 0:
                child_indent_len = indent_len
                break
        if child_indent_len is None:
            child_indent_len = 2
        child_indent = " " * child_indent_len

        for j in range(idx + 1, block_end):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len != child_indent_len:
                continue
            m = re.match(r"^(\s*hermes_launch_mode\s*:\s*)([^#\r\n]*?)(\s*(?:#.*)?)?$", lines[j])
            if not m:
                continue
            updated = f"{m.group(1)}{scalar}{m.group(3) or ''}"
            if updated == lines[j]:
                return raw, False
            next_lines = list(lines)
            next_lines[j] = updated
            return _join(next_lines), True

        insert_at = idx + 1
        while insert_at < block_end:
            s = lines[insert_at].strip()
            if not s:
                insert_at += 1
                continue
            indent_len = len(lines[insert_at]) - len(lines[insert_at].lstrip(" "))
            if indent_len > 0 and s.startswith("#"):
                insert_at += 1
                continue
            break

        next_lines = list(lines)
        next_lines.insert(insert_at, f"{child_indent}hermes_launch_mode: {scalar}")
        return _join(next_lines), True

    hermelin_cfg = parsed.get("hermelin")
    if isinstance(hermelin_cfg, dict):
        if _normalize_scalar_text(hermelin_cfg.get("hermes_launch_mode")) == normalized:
            return raw, False
        hermelin_cfg["hermes_launch_mode"] = normalized
        return _dump_yaml_mapping(parsed, newline, had_trailing_newline or not raw), True

    next_lines = list(lines)
    if next_lines and next_lines[-1].strip():
        next_lines.append("")
    next_lines.extend(["hermelin:", f"  hermes_launch_mode: {scalar}"])
    return _join(next_lines), True


def _update_platform_toolset_enabled_config_text(text: str, platform: str, toolset: str, enabled: bool) -> tuple[str, bool]:
    raw = text or ""
    platform = str(platform or "").strip()
    toolset = str(toolset or "").strip()
    if not platform or not toolset:
        return raw, False

    try:
        data = yaml.safe_load(raw) or {}
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    platform_toolsets_raw = data.get("platform_toolsets")
    if str(platform_toolsets_raw or "").strip().lower() == "all":
        return raw, False
    platform_toolsets = platform_toolsets_raw if isinstance(platform_toolsets_raw, dict) else {}
    current = platform_toolsets.get(platform) if isinstance(platform_toolsets, dict) else None

    if isinstance(current, list):
        items = [str(item).strip() for item in current if str(item).strip()]
    elif isinstance(current, str):
        items = [part.strip() for part in current.split(",") if part.strip()]
    elif current is None:
        items = []
    else:
        return raw, False

    if any(item == "all" for item in items):
        return raw, False

    if not items and enabled:
        items = ["hermes-cli"] if platform == "cli" and toolset != "hermes-cli" else []
        if platform == "cli" and toolset not in {"hermes-cli", "artifacts"}:
            items.append("artifacts")

    had_toolset = toolset in items
    if enabled and not had_toolset:
        items.append(toolset)
    elif not enabled and had_toolset:
        items = [item for item in items if item != toolset]
    else:
        return raw, False

    newline = "\r\n" if "\r\n" in raw else "\n"
    had_trailing_newline = raw.endswith(("\n", "\r"))
    lines = raw.splitlines()

    def _join(next_lines: list[str]) -> str:
        out = newline.join(next_lines)
        if next_lines and (had_trailing_newline or not raw):
            out += newline
        return out

    def _block_end(start_idx: int, parent_indent_len: int) -> int:
        end = len(lines)
        for j in range(start_idx + 1, len(lines)):
            s = lines[j].strip()
            if not s:
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len <= parent_indent_len:
                end = j
                break
        return end

    def _platform_value_end(start_idx: int, platform_indent_len: int) -> int:
        """Return the end of a platform_toolsets.<platform> value block.

        PyYAML often emits sequence values as:
            cli:
            - terminal
        where the list items are indented at the same level as the key. Treat
        same-indent dash lines as part of the current value, but stop at the
        next same-indent platform key.
        """
        end = len(lines)
        for j in range(start_idx + 1, len(lines)):
            s = lines[j].strip()
            if not s:
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len < platform_indent_len:
                end = j
                break
            if indent_len == platform_indent_len and not s.startswith("-"):
                end = j
                break
        return end

    def _first_child_indent(start_idx: int, end_idx: int, parent_indent_len: int) -> int:
        for j in range(start_idx + 1, end_idx):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len > parent_indent_len:
                return indent_len
        return parent_indent_len + 2

    def _render_items(list_indent_len: int) -> list[str]:
        return [f"{' ' * list_indent_len}- {_yaml_inline_scalar(item)}" for item in items]

    for idx, line in enumerate(lines):
        if line[:1].isspace():
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not re.match(r"^platform_toolsets\s*:\s*(?:#.*)?$", stripped):
            continue

        pt_end = _block_end(idx, 0)
        child_indent_len = _first_child_indent(idx, pt_end, 0)
        platform_re = re.escape(platform)
        for j in range(idx + 1, pt_end):
            s = lines[j].strip()
            if not s or s.startswith("#"):
                continue
            indent_len = len(lines[j]) - len(lines[j].lstrip(" "))
            if indent_len != child_indent_len:
                continue
            if not re.match(rf"^{platform_re}\s*:", s):
                continue

            platform_end = _platform_value_end(j, child_indent_len)
            platform_indent = " " * child_indent_len
            next_lines = list(lines)
            replacement = [f"{platform_indent}{platform}:"] + _render_items(child_indent_len + 2)
            next_lines[j:platform_end] = replacement
            return _join(next_lines), True

        insert_at = idx + 1
        while insert_at < pt_end:
            s = lines[insert_at].strip()
            if not s:
                insert_at += 1
                continue
            indent_len = len(lines[insert_at]) - len(lines[insert_at].lstrip(" "))
            if indent_len >= child_indent_len and s.startswith("#"):
                insert_at += 1
                continue
            break

        platform_indent = " " * child_indent_len
        next_lines = list(lines)
        next_lines[insert_at:insert_at] = [f"{platform_indent}{platform}:"] + _render_items(child_indent_len + 2)
        return _join(next_lines), True

    if isinstance(platform_toolsets, dict) and "platform_toolsets" in data:
        platform_toolsets[platform] = items
        return _dump_yaml_mapping(data, newline, had_trailing_newline or not raw), True

    next_lines = list(lines)
    if next_lines and next_lines[-1].strip():
        next_lines.append("")
    next_lines.extend(["platform_toolsets:", f"  {platform}:"] + _render_items(4))
    return _join(next_lines), True


def _set_command_toolset_enabled(command: str, toolset: str, enabled: bool) -> tuple[str, bool, str | None]:
    cmd = str(command or "").strip()
    toolset = str(toolset or "").strip()
    if not cmd:
        return command, False, "empty command"
    if not toolset:
        return command, False, "empty toolset"

    try:
        argv = shlex.split(cmd)
    except Exception as exc:
        return command, False, str(exc)

    if not argv:
        return command, False, "empty command"

    next_argv = list(argv)
    toolsets_idx = None
    toolsets_raw = None
    for i, token in enumerate(next_argv):
        if token == "--toolsets" and i + 1 < len(next_argv):
            toolsets_idx = i + 1
            toolsets_raw = next_argv[i + 1]
            break
        if token.startswith("--toolsets="):
            toolsets_idx = i
            toolsets_raw = token.split("=", 1)[1]
            break

    if toolsets_raw is None:
        return command, False, "command has no --toolsets"

    items = [part.strip() for part in str(toolsets_raw).split(",") if part.strip()]
    if any(item == "all" for item in items):
        return command, False, None

    had_toolset = toolset in items
    changed = False
    if enabled and not had_toolset:
        items.append(toolset)
        changed = True
    elif not enabled and had_toolset:
        items = [item for item in items if item != toolset]
        changed = True

    if not changed:
        return command, False, None

    updated_value = ", ".join(items)
    if toolsets_idx is None:
        return command, False, "command has no --toolsets"

    if next_argv[toolsets_idx].startswith("--toolsets="):
        next_argv[toolsets_idx] = f"--toolsets={updated_value}"
    else:
        next_argv[toolsets_idx] = updated_value

    return shlex.join(next_argv), True, None
