from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
from collections import OrderedDict
from typing import Any, Dict, Iterator, Optional

from flask import current_app


def _parsed_dir() -> str:
    path = os.path.join(current_app.config["STORAGE_ROOT"], "parsed")
    os.makedirs(path, exist_ok=True)
    return path


def route_cache_dir(sim_id: str) -> str:
    return os.path.join(_parsed_dir(), f"{sim_id}.frequency_routes")


def route_manifest_path(sim_id: str) -> str:
    return os.path.join(route_cache_dir(sim_id), "manifest.json")


def bestscore_aggregate_path(sim_id: str) -> str:
    return os.path.join(_parsed_dir(), f"{sim_id}.bestscore_aggregates.json")


def cleanup_frequency_route_cache(sim_id: str) -> None:
    try:
        shutil.rmtree(route_cache_dir(sim_id), ignore_errors=True)
    except Exception:
        current_app.logger.exception("[freq-cache] failed removing route cache dir for %s", sim_id)
    try:
        path = bestscore_aggregate_path(sim_id)
        if os.path.isfile(path):
            os.remove(path)
    except Exception:
        current_app.logger.exception("[freq-cache] failed removing bestscore aggregate for %s", sim_id)


def save_bestscore_aggregate_state(sim_id: str, state: Dict[str, Any]) -> str:
    path = bestscore_aggregate_path(sim_id)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    os.replace(tmp, path)
    return path


def load_bestscore_aggregate_state(sim_id: str) -> Optional[Dict[str, Any]]:
    path = bestscore_aggregate_path(sim_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except Exception:
        current_app.logger.exception("[freq-cache] failed reading bestscore aggregate for %s", sim_id)
        return None


def load_route_manifest(sim_id: str) -> Optional[Dict[str, Any]]:
    path = route_manifest_path(sim_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except Exception:
        current_app.logger.exception("[freq-cache] failed reading route manifest for %s", sim_id)
        return None


def iter_route_cached_persons(sim_id: str, route_id: str) -> Iterator[Dict[str, Any]]:
    manifest = load_route_manifest(sim_id)
    entry = (manifest or {}).get("routes", {}).get(str(route_id)) if isinstance(manifest, dict) else None
    if not isinstance(entry, dict):
        return
    rel = entry.get("file")
    if not isinstance(rel, str) or not rel:
        return
    path = os.path.join(route_cache_dir(sim_id), rel)
    if not os.path.isfile(path):
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


class RouteCacheWriter:
    def __init__(self, sim_id: str, *, max_open_files: int = 32) -> None:
        self.sim_id = sim_id
        self.base_dir = route_cache_dir(sim_id)
        self.tmp_dir = os.path.join(self.base_dir, "_tmp")
        os.makedirs(self.tmp_dir, exist_ok=True)
        self.max_open_files = max(1, int(max_open_files))
        self._handles: "OrderedDict[str, Any]" = OrderedDict()
        self._manifest: Dict[str, Any] = {"simId": sim_id, "routes": {}}

    def _hashed_name(self, route_id: str) -> str:
        return hashlib.sha1(route_id.encode("utf-8")).hexdigest()

    def _tmp_path(self, route_id: str) -> str:
        return os.path.join(self.tmp_dir, f"{self._hashed_name(route_id)}.ndjson")

    def _gzip_name(self, route_id: str) -> str:
        return f"{self._hashed_name(route_id)}.ndjson.gz"

    def _get_handle(self, route_id: str):
        handle = self._handles.pop(route_id, None)
        if handle is not None:
            self._handles[route_id] = handle
            return handle
        if len(self._handles) >= self.max_open_files:
            _, old = self._handles.popitem(last=False)
            try:
                old.close()
            except Exception:
                pass
        path = self._tmp_path(route_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        handle = open(path, "a", encoding="utf-8")
        self._handles[route_id] = handle
        return handle

    def append_person(self, route_id: str, person: Dict[str, Any]) -> None:
        route_id = str(route_id or "").strip()
        if not route_id:
            return
        handle = self._get_handle(route_id)
        handle.write(json.dumps(person, ensure_ascii=False))
        handle.write("\n")
        routes = self._manifest["routes"]
        entry = routes.setdefault(route_id, {"file": self._gzip_name(route_id), "count": 0})
        entry["count"] = int(entry.get("count") or 0) + 1

    def finalize(self) -> Optional[str]:
        for handle in self._handles.values():
            try:
                handle.close()
            except Exception:
                pass
        self._handles.clear()

        routes = self._manifest.get("routes") or {}
        if not isinstance(routes, dict) or not routes:
            shutil.rmtree(self.base_dir, ignore_errors=True)
            return None

        for route_id, entry in routes.items():
            if not isinstance(entry, dict):
                continue
            src = self._tmp_path(str(route_id))
            dst = os.path.join(self.base_dir, str(entry.get("file") or ""))
            if not os.path.isfile(src) or not dst:
                continue
            with open(src, "rb") as raw, gzip.open(dst, "wb") as gz:
                shutil.copyfileobj(raw, gz, length=1024 * 1024)
            try:
                os.remove(src)
            except Exception:
                pass

        try:
            shutil.rmtree(self.tmp_dir, ignore_errors=True)
        except Exception:
            pass

        manifest_path = route_manifest_path(self.sim_id)
        tmp = f"{manifest_path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self._manifest, fh)
        os.replace(tmp, manifest_path)
        return manifest_path
