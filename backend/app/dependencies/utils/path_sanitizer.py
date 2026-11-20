import re
from pathlib import Path


_FAT_INVALID_CHARS = (
    '\\x00-\\x1f\\x7f'
    '"*/:<>?\\\\|'
    '＂＊／：＜＞？＼｜'
    '\\uf022\\uf02a\\uf02f\\uf03a\\uf03c\\uf03e\\uf03f\\uf05c\\uf07c'
)
_INVALID_PATTERN = re.compile(rf"[{_FAT_INVALID_CHARS}]")
_INVALID_RUN_PATTERN = re.compile(rf"\s*[{_FAT_INVALID_CHARS}]+\s*")
_LEADING_INVALID_PATTERN = re.compile(rf"^(?:\s*[{_FAT_INVALID_CHARS}]+\s*)+")
_TRAILING_INVALID_PATTERN = re.compile(rf"(?:\s*[{_FAT_INVALID_CHARS}]+\s*)+$")
_REPEATED_SEPARATOR_PATTERN = re.compile(r"(?:\s+-\s*){2,}")


def sanitize_folder_name(value: str) -> str:
    """Return a FAT-compatible filesystem folder name without changing tags."""
    sanitized = value.strip()
    has_invalid_char = bool(_INVALID_PATTERN.search(sanitized))

    if has_invalid_char:
        sanitized = _LEADING_INVALID_PATTERN.sub("", sanitized)
        sanitized = _TRAILING_INVALID_PATTERN.sub("", sanitized)
        sanitized = _INVALID_RUN_PATTERN.sub(" - ", sanitized)
        sanitized = _REPEATED_SEPARATOR_PATTERN.sub(" - ", sanitized)

    # Trailing spaces and periods are fragile across Windows and sync providers.
    sanitized = sanitized.strip().rstrip(".").rstrip()
    return sanitized or "_"


def sanitize_file_name(value: str) -> str:
    """Return a FAT-compatible filename while preserving its final extension."""
    suffix = Path(value).suffix
    stem = value[:-len(suffix)] if suffix else value
    return f"{sanitize_folder_name(stem)}{suffix}"
