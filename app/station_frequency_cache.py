from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

from flask import current_app

from .models import get_simulation
from .person_cache import iter_cached_persons
from .station_counts import _resolve_station_center_from_schedule_path, resolve_station_center


SUPPORTED_STATION_BASELINES = (
    {"name": "西条駅", "radii": (300.0, 500.0, 800.0), "binSec": 3600},
)


def _parsed_dir() -> str:
    path = os.path.join(current_app.config["STORAGE_ROOT"], "parsed")
    os.makedirs(path, exist_ok=True)
    return path


def station_baseline_path(sim_id: str) -> str:
    return os.path.join(_parsed_dir(), f"{sim_id}.station_baselines.json")


def cleanup_station_baseline_cache(sim_id: str) -> None:
    try:
        path = station_baseline_path(sim_id)
        if os.path.isfile(path):
            os.remove(path)
    except Exception:
        current_app.logger.exception("[station-baseline] failed removing station baseline cache for %s", sim_id)


def _write_json(path: str, payload: Dict[str, Any]) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    os.replace(tmp, path)


def save_station_baseline_payload(sim_id: str, payload: Dict[str, Any]) -> str:
    path = station_baseline_path(sim_id)
    _write_json(path, payload)
    return path


def load_station_baseline_payload(sim_id: str) -> Optional[Dict[str, Any]]:
    path = station_baseline_path(sim_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except Exception:
        current_app.logger.exception("[station-baseline] failed reading station baseline cache for %s", sim_id)
        return None


def _normalize_station_aliases(name: str) -> List[str]:
    base = str(name or "").strip()
    if not base:
        return []
    compact = "".join(base.split())
    aliases = {compact}
    if compact.endswith("駅") and len(compact) > 1:
        aliases.add(compact[:-1])
    else:
        aliases.add(f"{compact}駅")
    return [a for a in aliases if a]


def _canonical_station_name(name: str) -> Optional[str]:
    aliases = set(_normalize_station_aliases(name))
    for spec in SUPPORTED_STATION_BASELINES:
        if aliases.intersection(_normalize_station_aliases(str(spec.get("name") or ""))):
            return str(spec.get("name") or "")
    return None


def _profile_key(radius_m: float, bin_sec: int) -> str:
    return f"{int(round(float(radius_m)))}:{int(bin_sec)}"


def _as_int_sec(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            return int(float(value))
        if isinstance(value, str):
            s = value.strip()
            if not s:
                return None
            if ":" in s:
                parts = s.split(":")
                if len(parts) == 3:
                    return int(int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2]))
        return int(float(value))
    except Exception:
        return None


def _plan_station_contribution(
    plan: Dict[str, Any],
    *,
    center_x: float,
    center_y: float,
    radius_sq: float,
    bin_sec: int,
) -> Dict[str, Any]:
    steps = plan.get("steps") or []
    if not isinstance(steps, list):
        return {"visited": False, "bins": [], "maxTimeSec": 0}

    bins: List[int] = []
    mask = 0
    visited = False
    max_time = 0

    for step in steps:
        if not isinstance(step, dict) or step.get("kind") != "activity":
            continue
        x = step.get("x")
        y = step.get("y")
        if x is None or y is None:
            continue
        try:
            dx = float(x) - center_x
            dy = float(y) - center_y
        except Exception:
            continue
        if (dx * dx + dy * dy) > radius_sq:
            continue

        visited = True

        st = _as_int_sec(step.get("startTime"))
        en = _as_int_sec(step.get("endTime"))
        dur = _as_int_sec(step.get("durationSec"))
        if st is None and en is None:
            continue
        if st is None and en is not None and dur is not None:
            st = en - dur
        if en is None and st is not None and dur is not None:
            en = st + dur
        if st is None or en is None or en < st:
            continue

        if en > max_time:
            max_time = en

        start_bin = st // bin_sec
        end_bin = start_bin if en == st else (max(st, en - 1) // bin_sec)
        for b in range(start_bin, end_bin + 1):
            bit = 1 << b
            if mask & bit:
                continue
            mask |= bit
            bins.append(b)

    return {"visited": visited, "bins": bins, "maxTimeSec": max_time}


def _ensure_len(lst: List[int], n: int) -> None:
    if n <= len(lst):
        return
    lst.extend([0] * (n - len(lst)))


class StationBaselineBuilder:
    def __init__(
        self,
        *,
        station_name: str,
        center_x: float,
        center_y: float,
        radius_m: float,
        bin_sec: int,
        match_count: int,
        matched_stops: List[Dict[str, Any]],
    ) -> None:
        self.station_name = station_name
        self.center_x = float(center_x)
        self.center_y = float(center_y)
        self.radius_m = float(radius_m)
        self.bin_sec = int(bin_sec)
        self.match_count = int(match_count)
        self.matched_stops = matched_stops
        self._radius_sq = self.radius_m * self.radius_m
        self.present_by_bin: List[int] = []
        self.unique_visitors = 0
        self.max_time_sec = 0

    def add_person_plan(self, person_id: str, plan: Dict[str, Any]) -> None:
        contribution = _plan_station_contribution(
            plan,
            center_x=self.center_x,
            center_y=self.center_y,
            radius_sq=self._radius_sq,
            bin_sec=self.bin_sec,
        )
        if contribution.get("visited"):
            self.unique_visitors += 1
        for b in contribution.get("bins") or []:
            try:
                idx = int(b)
            except Exception:
                continue
            _ensure_len(self.present_by_bin, idx + 1)
            self.present_by_bin[idx] += 1
        self.max_time_sec = max(self.max_time_sec, int(contribution.get("maxTimeSec") or 0))

    def profile_key(self) -> str:
        return _profile_key(self.radius_m, self.bin_sec)

    def to_profile(self) -> Dict[str, Any]:
        return {
            "stationName": self.station_name,
            "centerX": self.center_x,
            "centerY": self.center_y,
            "radiusM": self.radius_m,
            "binSec": self.bin_sec,
            "matchCount": self.match_count,
            "matchedStops": self.matched_stops,
            "uniqueVisitors": int(self.unique_visitors),
            "presentByBin": list(self.present_by_bin),
            "maxTimeSec": int(self.max_time_sec),
        }


def prepare_station_baseline_builders(schedule_path: Optional[str]) -> List[StationBaselineBuilder]:
    if not schedule_path or not os.path.isfile(schedule_path):
        return []

    builders: List[StationBaselineBuilder] = []
    for spec in SUPPORTED_STATION_BASELINES:
        station_name = str(spec.get("name") or "").strip()
        if not station_name:
            continue
        try:
            resolved = _resolve_station_center_from_schedule_path(schedule_path, station_name)
        except Exception:
            current_app.logger.exception("[station-baseline] failed resolving %s from %s", station_name, schedule_path)
            continue
        if not isinstance(resolved, dict):
            continue
        for radius in spec.get("radii") or ():
            try:
                radius_m = float(radius)
            except Exception:
                continue
            builders.append(
                StationBaselineBuilder(
                    station_name=station_name,
                    center_x=float(resolved.get("centerX")),
                    center_y=float(resolved.get("centerY")),
                    radius_m=radius_m,
                    bin_sec=int(spec.get("binSec") or 3600),
                    match_count=int(resolved.get("matchCount") or 0),
                    matched_stops=list(resolved.get("matchedStops") or [])[:20],
                )
            )
    return builders


def builders_to_payload(sim_id: str, builders: List[StationBaselineBuilder]) -> Dict[str, Any]:
    stations: Dict[str, Any] = {}
    for builder in builders:
        station = stations.setdefault(
            builder.station_name,
            {
                "stationName": builder.station_name,
                "centerX": builder.center_x,
                "centerY": builder.center_y,
                "matchCount": builder.match_count,
                "matchedStops": builder.matched_stops,
                "profiles": {},
            },
        )
        station["profiles"][builder.profile_key()] = builder.to_profile()
    return {"simId": sim_id, "stations": stations}


def get_station_baseline_profile(
    sim_id: str,
    station_name: str,
    radius_m: float,
    bin_sec: int,
) -> Optional[Dict[str, Any]]:
    canonical = _canonical_station_name(station_name)
    if not canonical:
        return None
    payload = load_station_baseline_payload(sim_id)
    station = ((payload or {}).get("stations") or {}).get(canonical) if isinstance(payload, dict) else None
    if not isinstance(station, dict):
        return None
    profile = (station.get("profiles") or {}).get(_profile_key(radius_m, bin_sec))
    return profile if isinstance(profile, dict) else None


def _best_plan_for_person(person: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    plans = person.get("plans") or []
    if not isinstance(plans, list) or not plans:
        return None
    best_idx = person.get("bestServerScorePlanIndex")
    if isinstance(best_idx, int) and 0 <= best_idx < len(plans):
        plan = plans[best_idx]
        return plan if isinstance(plan, dict) else None

    best_plan = None
    best_score = float("-inf")
    for plan in plans:
        if not isinstance(plan, dict):
            continue
        try:
            score = float(plan.get("serverScore") or 0.0)
        except Exception:
            score = 0.0
        if best_plan is None or score > best_score:
            best_plan = plan
            best_score = score
    return best_plan


def ensure_station_baseline_profile(
    sim_id: str,
    station_name: str,
    radius_m: float,
    bin_sec: int,
) -> Optional[Dict[str, Any]]:
    profile = get_station_baseline_profile(sim_id, station_name, radius_m, bin_sec)
    if isinstance(profile, dict):
        return profile

    canonical = _canonical_station_name(station_name)
    if not canonical:
        return None
    spec = next((s for s in SUPPORTED_STATION_BASELINES if str(s.get("name") or "") == canonical), None)
    if not isinstance(spec, dict):
        return None

    radius_n = float(radius_m)
    bin_sec_n = int(bin_sec)
    supported_radii = {float(r) for r in spec.get("radii") or ()}
    if radius_n not in supported_radii or bin_sec_n != int(spec.get("binSec") or 3600):
        return None

    sim = get_simulation(sim_id)
    if not sim:
        return None
    cache_path = sim.get("cached_json_path")
    if not cache_path or not os.path.isfile(str(cache_path)):
        return None

    try:
        resolved = resolve_station_center(sim_id, canonical)
    except Exception:
        current_app.logger.exception("[station-baseline] failed resolving %s for %s", canonical, sim_id)
        return None

    current_app.logger.info(
        "[station-baseline] building on demand sim=%s station=%s radius=%s bin=%s",
        sim_id,
        canonical,
        int(round(radius_n)),
        bin_sec_n,
    )
    builder = StationBaselineBuilder(
        station_name=canonical,
        center_x=float(resolved.get("centerX") or 0.0),
        center_y=float(resolved.get("centerY") or 0.0),
        radius_m=radius_n,
        bin_sec=bin_sec_n,
        match_count=int(resolved.get("matchCount") or 0),
        matched_stops=list(resolved.get("matchedStops") or [])[:20],
    )

    for person in iter_cached_persons(str(cache_path)):
        if not isinstance(person, dict):
            continue
        plan = _best_plan_for_person(person)
        if not isinstance(plan, dict):
            continue
        builder.add_person_plan(str(person.get("personId") or ""), plan)

    payload = load_station_baseline_payload(sim_id) or {"simId": sim_id, "stations": {}}
    stations = payload.setdefault("stations", {})
    station_payload = stations.setdefault(
        canonical,
        {
            "stationName": canonical,
            "centerX": builder.center_x,
            "centerY": builder.center_y,
            "matchCount": builder.match_count,
            "matchedStops": builder.matched_stops,
            "profiles": {},
        },
    )
    station_payload["stationName"] = canonical
    station_payload["centerX"] = builder.center_x
    station_payload["centerY"] = builder.center_y
    station_payload["matchCount"] = builder.match_count
    station_payload["matchedStops"] = builder.matched_stops
    station_payload.setdefault("profiles", {})[builder.profile_key()] = builder.to_profile()
    save_station_baseline_payload(sim_id, payload)
    return builder.to_profile()
