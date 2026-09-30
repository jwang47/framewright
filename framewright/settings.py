"""Machine-local settings shared by the server, importer and renderer.

Paths in config.json are relative to that file; CLI and environment paths
are relative to the working directory. Reading settings never creates files.
"""
from __future__ import annotations

import json
import os
import sys
import string
import re
from pathlib import Path


def config_path() -> Path:
    override = os.environ.get("STUDIO_CONFIG")
    if override:
        return Path(override).expanduser().resolve()
    base = Path(os.environ.get("APPDATA") or Path.home() / "AppData/Roaming") if sys.platform == "win32" else Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "framewright" / "config.json"


def _path(value: str, base: Path | None = None) -> Path:
    path = Path(value).expanduser()
    return ((base / path) if base and not path.is_absolute() else path).resolve()


def load_config() -> dict:
    path = config_path()
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise ValueError(f"cannot read settings at {path}: {exc}") from exc
    if not isinstance(config, dict):
        raise ValueError(f"settings at {path} must be a JSON object")
    for key in ("library", "store"):
        if config.get(key) is not None and (not isinstance(config[key], str) or not config[key].strip()):
            raise ValueError(f"settings {key} must be a non-empty folder path or null")
    luts = config.get("luts", [])
    if not isinstance(luts, (str, list)) or (isinstance(luts, list) and any(not isinstance(p, str) or not p.strip() for p in luts)) or (isinstance(luts, str) and not luts.strip()):
        raise ValueError("settings luts must be a folder path or a list of folder paths")
    if "shoot_folder_pattern" in config:
        validate_shoot_pattern(config["shoot_folder_pattern"])
    if "delete_from_card" in config and not isinstance(config["delete_from_card"], bool):
        raise ValueError("settings delete_from_card must be true or false")
    if "port" in config:
        validate_port(config["port"])
    return config


def validate_port(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ValueError("port must be an integer between 1 and 65535")
    return value


def resolve_library(explicit: str | Path | None = None) -> Path | None:
    value = explicit or os.environ.get("STUDIO_LIBRARY")
    if value:
        return _path(str(value))
    value = load_config().get("library")
    return _path(value, config_path().parent) if value else None


def configured_store() -> Path | None:
    value = os.environ.get("STUDIO_STORE") or os.environ.get("PHOTO_STORE")
    if value:
        return _path(value)
    value = load_config().get("store")
    return _path(value, config_path().parent) if value else None


def configured_port(explicit: int | None = None) -> int:
    return validate_port(explicit if explicit is not None else load_config().get("port", 8765))


def user_lut_directory() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/framewright/luts"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData/Roaming") / "framewright/luts"
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "framewright/luts"


def lut_directories(library: Path) -> list[Path]:
    paths = [_path(p) for p in os.environ.get("STUDIO_LUTS", "").split(os.pathsep) if p]
    configured = load_config().get("luts", [])
    if isinstance(configured, str):
        configured = [configured]
    paths.extend(_path(p, config_path().parent) for p in configured)
    paths.extend((user_lut_directory().resolve(), library.resolve() / "luts"))
    return list(dict.fromkeys(paths))


def save_library(library: Path) -> None:
    """Persist the first-run choice, preserving other settings."""
    config = load_config()
    config["library"] = str(library.resolve())
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.part")
    temporary.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def validate_shoot_pattern(pattern: str) -> str:
    """Only date/camera placeholders and portable folder-name characters."""
    if not isinstance(pattern, str) or not pattern or len(pattern) > 120:
        raise ValueError("shoot_folder_pattern must be a short non-empty folder pattern")
    try:
        fields = list(string.Formatter().parse(pattern))
    except ValueError as exc:
        raise ValueError("invalid shoot_folder_pattern") from exc
    if any(field not in (None, "date", "camera") or spec or conversion
           for _, field, spec, conversion in fields):
        raise ValueError("shoot_folder_pattern supports only {date} and {camera}")
    if not {"date", "camera"}.issubset({field for _, field, _, _ in fields}):
        raise ValueError("shoot_folder_pattern must include {date} and {camera}")
    rendered = pattern.format(date="2026-01-01", camera="camera")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _.-]*", rendered) or rendered.endswith((".", " ")) or ".." in rendered:
        raise ValueError("shoot_folder_pattern must produce one safe folder name")
    return pattern


def import_settings() -> tuple[str, bool]:
    config = load_config()
    return config.get("shoot_folder_pattern", "{date}_{camera}"), config.get("delete_from_card", False)
