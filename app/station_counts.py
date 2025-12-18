from __future__ import annotations

import gzip
import io
import json
import os
import shutil
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from itertools import islice
from typing import Any, Dict, Iterable, List, Optional, Tuple

from flask import current_app
from azure.storage.blob import BlobClient

from .azure_utils import get_storage_context
from .models import get_simulation
from .parsing import parse_facilities_file
from .person_cache import iter_cached_persons


_EVENT_CANDIDATES = ("output_events.xml.gz", "output_events.xml", "events.xml.gz", "events.xml")
_FACILITY_CANDIDATES = (
    "output_facilities.xml.gz",
    "facilities.xml.gz",
    "output_facilities.xml",
    "facilities.xml",
)


def _find_first_existing(folder: str, candidates: Tuple[str, ...]) -> Optional[str]:
    for name in candidates:
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            return path
    return None


def _extract_member(zf: zipfile.ZipFile, member: str, dest_dir: str) -> str:
    dst = os.path.join(dest_dir, os.path.basename(member))
    with zf.open(member) as src, open(dst, "wb") as dst_file:
        shutil.copyfileobj(src, dst_file, length=1024 * 1024)
    return dst


def _locate_member(zf: zipfile.ZipFile, wanted: Tuple[str, ...]) -> Optional[str]:
    wanted_lc = {name.lower() for name in wanted}
    for info in zf.infolist():
        if info.is_dir():
            continue
        base = os.path.basename(info.filename).lower()
        if base in wanted_lc:
            return info.filename
    return None


def _open_maybe_gzip_path(path: str):
    with open(path, "rb") as raw:
        head = raw.read(2)
    if head == b"\x1f\x8b":
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, "r", encoding="utf-8")


def _as_int_sec(t: Any) -> Optional[int]:
    if t is None:
        return None
    try:
        if isinstance(t, (int, float)):
            return int(float(t))
        if isinstance(t, str):
            s = t.strip()
            if not s:
                return None
            # Accept "HH:MM:SS" (or "H:MM:SS") common in plans.
            if ":" in s:
                parts = s.split(":")
                if len(parts) == 3:
                    h = int(parts[0])
                    m = int(parts[1])
                    sec = float(parts[2])
                    return int(h * 3600 + m * 60 + sec)
                if len(parts) == 2:
                    h = int(parts[0])
                    m = float(parts[1])
                    return int(h * 3600 + m * 60)
        # MATSim times are typically float seconds.
        return int(float(t))
    except Exception:
        return None


def _is_activity_start(type_name: str) -> bool:
    t = (type_name or "").strip().lower()
    return t in {"actstart", "activitystart"}


def _is_activity_end(type_name: str) -> bool:
    t = (type_name or "").strip().lower()
    return t in {"actend", "activityend"}


def _event_person(attrs: Dict[str, str]) -> Optional[str]:
    return attrs.get("person") or attrs.get("personId") or attrs.get("person_id")


def _event_facility(attrs: Dict[str, str]) -> Optional[str]:
    return attrs.get("facility") or attrs.get("facilityId") or attrs.get("facility_id")


def _ensure_len(lst: List[int], n: int) -> None:
    if n <= len(lst):
        return
    lst.extend([0] * (n - len(lst)))


@dataclass(frozen=True)
class StationQuery:
    center_x: float
    center_y: float
    radius_m: float
    bin_sec: int = 3600
    person_limit: Optional[int] = None

    def cache_key(self, sim_id: str) -> str:
        # Round to avoid cache fragmentation from tiny float deltas.
        x = round(float(self.center_x), 3)
        y = round(float(self.center_y), 3)
        r = round(float(self.radius_m), 3)
        b = int(self.bin_sec)
        pl = self.person_limit
        pl_key = f"n{int(pl)}" if isinstance(pl, int) and pl > 0 else "all"
        return f"{sim_id}.station.x{x}.y{y}.r{r}.b{b}.{pl_key}.json"


def _read_cached(path: str) -> Optional[Dict[str, Any]]:
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else None
    except Exception:
        return None
    return None


def station_cache_path(sim_id: str, q: StationQuery) -> str:
    parsed_dir = os.path.join(current_app.config["STORAGE_ROOT"], "parsed")
    return os.path.join(parsed_dir, q.cache_key(sim_id))


def read_station_cache(sim_id: str, q: StationQuery) -> Optional[Dict[str, Any]]:
    return _read_cached(station_cache_path(sim_id, q))


def _write_cached(path: str, payload: Dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        os.replace(tmp, path)
    except Exception:
        current_app.logger.exception("[station] failed writing cache: %s", path)


def _load_facilities_from_folder(folder: str) -> Dict[str, Tuple[float, float]]:
    fpath = _find_first_existing(folder, tuple(_FACILITY_CANDIDATES))
    if not fpath:
        return {}
    try:
        return parse_facilities_file(fpath)
    except Exception:
        current_app.logger.exception("[station] failed parsing facilities from %s", fpath)
        return {}


def _load_facilities_from_zip(zf: zipfile.ZipFile, dest_dir: str) -> Dict[str, Tuple[float, float]]:
    mem = _locate_member(zf, tuple(_FACILITY_CANDIDATES))
    if not mem:
        return {}
    try:
        fp = _extract_member(zf, mem, dest_dir)
        return parse_facilities_file(fp)
    except Exception:
        current_app.logger.exception("[station] failed parsing facilities from zip member %s", mem)
        return {}


def _iter_events(path: str) -> Iterable[Dict[str, str]]:
    """
    Yields the attributes dict of each <event .../> element from a (possibly gzipped) events.xml.
    """
    with _open_maybe_gzip_path(path) as f:
        context = ET.iterparse(f, events=("end",))
        for _ev, elem in context:
            if elem.tag != "event":
                elem.clear()
                continue
            attrs = dict(elem.attrib) if elem.attrib else {}
            elem.clear()
            if attrs:
                yield attrs


def _resolve_cache_path(path: str) -> str:
    return path if os.path.isabs(path) else os.path.abspath(path)


def _pick_selected_plan(person: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    plans = person.get("plans") or []
    if not isinstance(plans, list) or not plans:
        return None
    idx = person.get("selectedPlanIndex")
    if not isinstance(idx, int) or idx < 0 or idx >= len(plans):
        idx = 0
    plan = plans[idx] if 0 <= idx < len(plans) else plans[0]
    return plan if isinstance(plan, dict) else None


def _compute_station_counts_from_person_cache(sim_id: str, q: StationQuery) -> Dict[str, Any]:
    sim = get_simulation(sim_id)
    if not sim:
        raise LookupError("simulation not found")

    cache = sim.get("cached_json_path")
    if not cache:
        raise FileNotFoundError("No cached persons data (cached_json_path missing)")
    cache_path = _resolve_cache_path(str(cache))
    if not os.path.isfile(cache_path):
        raise FileNotFoundError("Cached persons file missing")

    r2 = float(q.radius_m) * float(q.radius_m)
    cx = float(q.center_x)
    cy = float(q.center_y)
    bin_sec = max(1, int(q.bin_sec))
    person_limit = q.person_limit
    if person_limit is not None:
        try:
            person_limit = int(person_limit)
        except Exception:
            person_limit = None
    if person_limit is not None and person_limit <= 0:
        person_limit = None

    present_by_bin: List[int] = []
    unique_visitors: set[str] = set()
    max_time = 0

    persons_iter: Iterable[Dict[str, Any]] = iter_cached_persons(cache_path)
    if person_limit is not None:
        persons_iter = islice(persons_iter, person_limit)

    for p in persons_iter:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("personId") or "")
        if not pid:
            continue
        plan = _pick_selected_plan(p)
        if not plan:
            continue
        steps = plan.get("steps") or []
        if not isinstance(steps, list):
            continue

        mask = 0
        saw_inside = False

        for s in steps:
            if not isinstance(s, dict):
                continue
            if s.get("kind") != "activity":
                continue
            x = s.get("x")
            y = s.get("y")
            if x is None or y is None:
                continue
            try:
                dx = float(x) - cx
                dy = float(y) - cy
            except Exception:
                continue
            if (dx * dx + dy * dy) > r2:
                continue

            saw_inside = True

            st = _as_int_sec(s.get("startTime"))
            en = _as_int_sec(s.get("endTime"))
            dur = _as_int_sec(s.get("durationSec"))
            if st is None and en is None:
                continue
            if st is None and en is not None and dur is not None:
                st = en - dur
            if en is None and st is not None and dur is not None:
                en = st + dur
            if st is None or en is None:
                continue

            if en < st:
                continue

            if en > max_time:
                max_time = en

            if en == st:
                start_bin = st // bin_sec
                end_bin = start_bin
            else:
                start_bin = st // bin_sec
                end_bin = (max(st, en - 1) // bin_sec)

            for b in range(start_bin, end_bin + 1):
                bit = 1 << b
                if mask & bit:
                    continue
                mask |= bit
                _ensure_len(present_by_bin, b + 1)
                present_by_bin[b] += 1

        if saw_inside:
            unique_visitors.add(pid)

    return {
        "simulationId": sim_id,
        "centerX": cx,
        "centerY": cy,
        "radiusM": float(q.radius_m),
        "binSec": bin_sec,
        "maxTimeSec": max_time,
        "uniqueVisitors": len(unique_visitors),
        "presentByBin": present_by_bin,
        "personLimit": person_limit,
        "method": "person_cache_selected_plan",
    }


def compute_station_counts(sim_id: str, q: StationQuery) -> Dict[str, Any]:
    """
    Compute station-area counts using output_events.xml(.gz):
      - uniqueVisitors: distinct persons with any activity start/end inside the station radius
      - presentByBin: for each bin, distinct persons with any activity interval overlapping that bin
    """
    if q.person_limit is not None:
        payload = _compute_station_counts_from_person_cache(sim_id, q)
        cache_path = station_cache_path(sim_id, q)
        _write_cached(cache_path, payload)
        return payload

    sim = get_simulation(sim_id)
    if not sim:
        raise LookupError("simulation not found")

    cache_path = station_cache_path(sim_id, q)
    cached = _read_cached(cache_path)
    if cached:
        return cached

    folder = sim.get("path") or ""
    events_path: Optional[str] = None
    facilities_map: Dict[str, Tuple[float, float]] = {}

    # Prefer locally cached events (created during blob-parse) if present.
    cached_events = sim.get("cached_events_path")
    if cached_events and os.path.isfile(str(cached_events)):
        events_path = str(cached_events)
        if folder and os.path.isdir(folder):
            facilities_map = _load_facilities_from_folder(folder)
        else:
            # If the simulation doesn't have a local extraction, try to pull facilities from the zip
            # as we do below; the events cache itself doesn't include coordinates.
            facilities_map = {}
    elif folder and os.path.isdir(folder):
        events_path = _find_first_existing(folder, tuple(_EVENT_CANDIDATES))
        facilities_map = _load_facilities_from_folder(folder)
        if not events_path:
            raise FileNotFoundError("events file not found in local folder")
    else:
        blob_name = sim.get("blob_name")
        if not blob_name:
            raise FileNotFoundError("No path or blob available for events")

        bsc, _account, container, _key = get_storage_context()
        blob: BlobClient = bsc.get_blob_client(container, blob_name)

        with tempfile.TemporaryDirectory(dir=current_app.config["STORAGE_ROOT"]) as tmpd:
            tmp_zip = os.path.join(tmpd, "sim.zip")
            current_app.logger.info("[station] downloading blob %s to %s", blob_name, tmp_zip)
            with open(tmp_zip, "wb") as handle:
                blob.download_blob().readinto(handle)

            with zipfile.ZipFile(tmp_zip, "r") as zf:
                ev_member = _locate_member(zf, tuple(_EVENT_CANDIDATES))
                if not ev_member:
                    raise FileNotFoundError("events file not found in zip")
                events_path = _extract_member(zf, ev_member, tmpd)
                facilities_map = _load_facilities_from_zip(zf, tmpd)

            # fall through to parse using extracted events_path

    if not facilities_map:
        raise FileNotFoundError("facilities file not found (required to locate event facilities)")

    if not events_path:
        raise FileNotFoundError("events path resolution failed")

    r2 = float(q.radius_m) * float(q.radius_m)
    cx = float(q.center_x)
    cy = float(q.center_y)
    bin_sec = max(1, int(q.bin_sec))

    open_start: Dict[str, int] = {}
    bin_mask_by_person: Dict[str, int] = {}
    present_by_bin: List[int] = []
    unique_visitors: set[str] = set()
    max_time = 0

    # Hot local bindings
    mask_get = bin_mask_by_person.get
    mask_set = bin_mask_by_person.__setitem__
    open_get = open_start.get
    open_set = open_start.__setitem__
    open_del = open_start.__delitem__
    present_inc = present_by_bin.__setitem__

    for attrs in _iter_events(events_path):
        typ = attrs.get("type") or ""
        if not (_is_activity_start(typ) or _is_activity_end(typ)):
            continue

        pid = _event_person(attrs)
        if not pid:
            continue

        facility_id = _event_facility(attrs)
        if not facility_id:
            continue

        xy = facilities_map.get(facility_id)
        if not xy:
            continue

        dx = float(xy[0]) - cx
        dy = float(xy[1]) - cy
        if (dx * dx + dy * dy) > r2:
            continue

        t = _as_int_sec(attrs.get("time"))
        if t is None:
            continue
        if t > max_time:
            max_time = t

        unique_visitors.add(pid)

        if _is_activity_start(typ):
            if open_get(pid) is None:
                open_set(pid, t)
            continue

        # Activity end
        st = open_get(pid)
        if st is None:
            continue
        if t < st:
            open_del(pid)
            continue

        end = t
        if end == st:
            # Treat instantaneous activities as "present" in that bin.
            start_bin = st // bin_sec
            end_bin = start_bin
        else:
            start_bin = st // bin_sec
            end_bin = (max(st, end - 1) // bin_sec)

        m = int(mask_get(pid) or 0)
        for b in range(start_bin, end_bin + 1):
            bit = 1 << b
            if m & bit:
                continue
            m |= bit
            _ensure_len(present_by_bin, b + 1)
            present_inc(b, present_by_bin[b] + 1)
        mask_set(pid, m)
        open_del(pid)

    # Close any remaining open intervals at max_time (or end-of-day surrogate).
    close_t = max(max_time, 0)
    for pid, st in list(open_start.items()):
        if st is None:
            continue
        end = close_t
        if end < st:
            continue
        start_bin = st // bin_sec
        end_bin = (max(st, end - 1) // bin_sec) if end != st else start_bin
        m = int(mask_get(pid) or 0)
        for b in range(start_bin, end_bin + 1):
            bit = 1 << b
            if m & bit:
                continue
            m |= bit
            _ensure_len(present_by_bin, b + 1)
            present_inc(b, present_by_bin[b] + 1)
        mask_set(pid, m)

    payload: Dict[str, Any] = {
        "simulationId": sim_id,
        "centerX": cx,
        "centerY": cy,
        "radiusM": float(q.radius_m),
        "binSec": bin_sec,
        "maxTimeSec": max_time,
        "uniqueVisitors": len(unique_visitors),
        "presentByBin": present_by_bin,
        "personLimit": None,
        "method": "events",
    }
    _write_cached(cache_path, payload)
    return payload
