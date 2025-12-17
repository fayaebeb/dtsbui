from __future__ import annotations

import gzip
import json
from typing import Any, Dict, Iterable, Iterator, List, Literal


CacheFormat = Literal["json_array", "ndjson"]


def detect_cache_format(path: str) -> CacheFormat:
    """
    Detect cache format inside a gzip file:
      - "json_array": a single JSON array (legacy)
      - "ndjson": one JSON object per line
    """
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for ch in iter(lambda: fh.read(1), ""):
            if not ch:
                break
            if ch.isspace():
                continue
            return "json_array" if ch == "[" else "ndjson"
    return "ndjson"


def iter_cached_persons(path: str) -> Iterator[Dict[str, Any]]:
    fmt = detect_cache_format(path)
    if fmt == "json_array":
        decoder = json.JSONDecoder()
        buf = ""
        in_array = False
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            while True:
                chunk = fh.read(65536)
                if not chunk:
                    break
                buf += chunk

                if not in_array:
                    # find '['
                    i = 0
                    while i < len(buf) and buf[i].isspace():
                        i += 1
                    if i < len(buf) and buf[i] == "[":
                        in_array = True
                        buf = buf[i + 1 :]
                    else:
                        # need more data
                        if len(buf) > 1024 * 1024:
                            buf = buf[-1024 * 1024 :]
                        continue

                while True:
                    # Skip whitespace + commas
                    j = 0
                    while j < len(buf) and (buf[j].isspace() or buf[j] == ","):
                        j += 1
                    buf = buf[j:]
                    if not buf:
                        break
                    if buf[0] == "]":
                        return
                    try:
                        obj, idx = decoder.raw_decode(buf)
                    except json.JSONDecodeError:
                        # Need more data
                        break
                    buf = buf[idx:]
                    if isinstance(obj, dict):
                        yield obj

        # Fall through: ignore trailing partial buffer
        return

    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if isinstance(obj, dict):
                yield obj


def read_cached_persons_sample(path: str, limit: int) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    limit = max(1, int(limit))
    for p in iter_cached_persons(path):
        out.append(p)
        if len(out) >= limit:
            break
    return out


def write_ndjson_gz(path: str, items: Iterable[Dict[str, Any]]) -> int:
    """
    Write NDJSON (one JSON per line) into gzip file.
    Returns count of items written.
    """
    count = 0
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        for item in items:
            fh.write(json.dumps(item, ensure_ascii=False))
            fh.write("\n")
            count += 1
    return count
