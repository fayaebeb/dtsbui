import gzip
import json
import io
import os
import xml.etree.ElementTree as ET
import math
from typing import Any, Dict, Iterator, List, Optional, Union


def parse_time_to_seconds(time_str: Optional[str]) -> Optional[int]:
    if not time_str:
        return None
    try:
        h, m, s = time_str.split(":")
        return int(h) * 3600 + int(m) * 60 + int(float(s))
    except Exception:
        return None


def sec_to_time(sec: Optional[int]) -> Optional[str]:
    if sec is None:
        return None
    sec = max(0, int(round(sec)))
    h = sec // 3600
    m = (sec % 3600) // 60
    s = sec % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def safe_float(val: Optional[str]) -> Optional[float]:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except Exception:
        return None


def open_maybe_gzip_path(path: str):
    with open(path, "rb") as raw:
        head = raw.read(2)
    if head == b"\x1f\x8b":
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, "r", encoding="utf-8")


def open_maybe_gzip_stream(stream: io.BufferedReader):
    head = stream.read(2)
    stream.seek(0)
    if head == b"\x1f\x8b":
        return gzip.open(stream, "rt", encoding="utf-8")
    return io.TextIOWrapper(stream, encoding="utf-8")


def parse_facilities_file(path_or_stream: Union[str, io.BufferedReader]) -> Dict[str, tuple]:
    facilities: Dict[str, tuple] = {}
    if isinstance(path_or_stream, str):
        fobj = open_maybe_gzip_path(path_or_stream)
    else:
        fobj = open_maybe_gzip_stream(path_or_stream)
    with fobj as f:
        context = ET.iterparse(f, events=("start",))
        for event, elem in context:
            if elem.tag == "facility":
                fid = elem.attrib.get("id")
                x = elem.attrib.get("x")
                y = elem.attrib.get("y")
                if fid and x and y:
                    try:
                        facilities[fid] = (float(x), float(y))
                    except Exception:
                        pass
                elem.clear()
    return facilities


DEFAULT_MODE_PARAMS: Dict[str, Dict[str, float]] = {
    "other": {
        "constant": 0.0,
        "dailyMonetaryConstant": 0.0,
        "dailyUtilityConstant": 0.0,
        "marginalUtilityOfDistance_util_m": 0.0,
        "marginalUtilityOfTraveling_util_hr": -6.0,
        "monetaryDistanceRate": 0.0,
    },
    "car": {
        "constant": 2.7557,
        "dailyMonetaryConstant": 0.0,
        "dailyUtilityConstant": 0.0,
        "marginalUtilityOfDistance_util_m": 0.0,
        "marginalUtilityOfTraveling_util_hr": -2.3394,
        "monetaryDistanceRate": 0.0,
    },
    "pt": {
        "constant": 0.0,
        "dailyMonetaryConstant": 0.0,
        "dailyUtilityConstant": 0.0,
        "marginalUtilityOfDistance_util_m": 0.0,
        "marginalUtilityOfTraveling_util_hr": -2.3394,
        "monetaryDistanceRate": -0.0825,
    },
    "walk": {
        "constant": 1.94794,
        "dailyMonetaryConstant": 0.0,
        "dailyUtilityConstant": 0.0,
        "marginalUtilityOfDistance_util_m": 0.0,
        "marginalUtilityOfTraveling_util_hr": -2.3394,
        "monetaryDistanceRate": 0.0,
    },
    "transit_walk": {
        "constant": 1.94794,
        "dailyMonetaryConstant": 0.0,
        "dailyUtilityConstant": 0.0,
        "marginalUtilityOfDistance_util_m": 0.0,
        "marginalUtilityOfTraveling_util_hr": -2.3394,
        "monetaryDistanceRate": 0.0,
    },
    "bike": {
        "constant": -0.02936,
        "dailyMonetaryConstant": 0.0,
        "dailyUtilityConstant": 0.0,
        "marginalUtilityOfDistance_util_m": 0.0,
        "marginalUtilityOfTraveling_util_hr": -2.3394,
        "monetaryDistanceRate": 0.0,
    },
    "transit_bike": {
        "constant": -10.02936,
        "dailyMonetaryConstant": 0.0,
        "dailyUtilityConstant": 0.0,
        "marginalUtilityOfDistance_util_m": 0.0,
        "marginalUtilityOfTraveling_util_hr": -2.3394,
        "monetaryDistanceRate": 0.0,
    },
    "ride": {
        "constant": 0.11062,
        "dailyMonetaryConstant": 0.0,
        "dailyUtilityConstant": 0.0,
        "marginalUtilityOfDistance_util_m": 0.0,
        "marginalUtilityOfTraveling_util_hr": -2.3394,
        "monetaryDistanceRate": 0.0,
    },
}

DEFAULT_MARGINAL_UTILITY_OF_MONEY = 1.0
DEFAULT_PERFORMING_UTILITY_UTIL_HR = 6.0
DEFAULT_WAITING_PT_UTILITY_UTIL_HR = -2.3394
DEFAULT_LATE_ARRIVAL_UTILITY_UTIL_HR = -18.0


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _empty_mode_params() -> Dict[str, float]:
    return {
        "constant": 0.0,
        "dailyMonetaryConstant": 0.0,
        "dailyUtilityConstant": 0.0,
        "marginalUtilityOfDistance_util_m": 0.0,
        "marginalUtilityOfTraveling_util_hr": 0.0,
        "monetaryDistanceRate": 0.0,
    }


def _empty_activity_params() -> Dict[str, Any]:
    return {
        "activityType": "",
        "closingTimeSec": None,
        "earliestEndTimeSec": None,
        "latestStartTimeSec": None,
        "minimalDurationSec": None,
        "openingTimeSec": None,
        "priority": 1.0,
        "scoringThisActivityAtAll": True,
        "typicalDurationSec": None,
        "typicalDurationScoreComputation": "relative",
    }


def _coerce_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except Exception:
        return default


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _parse_config_time_to_sec(value: Any) -> Optional[int]:
    if value in (None, "", "undefined", "null", "None"):
        return None
    if isinstance(value, (int, float)):
        return int(float(value))
    text = str(value).strip()
    if not text or text.lower() in {"undefined", "null", "none"}:
        return None
    if ":" in text:
        return parse_time_to_seconds(text)
    try:
        return int(float(text))
    except Exception:
        return None


def parse_config_file(path_or_stream: Union[str, io.BufferedReader]) -> Dict[str, Any]:
    """
    Parse MATSim scoring modeParams from output_config.xml(.gz).
    Falls back field-by-field to DEFAULT_MODE_PARAMS when values are absent.
    """
    mode_params: Dict[str, Dict[str, float]] = {
        mode: dict(params) for mode, params in DEFAULT_MODE_PARAMS.items()
    }
    activity_params: Dict[str, Dict[str, Any]] = {}
    marginal_utility_of_money = DEFAULT_MARGINAL_UTILITY_OF_MONEY
    performing = DEFAULT_PERFORMING_UTILITY_UTIL_HR
    waiting_pt = DEFAULT_WAITING_PT_UTILITY_UTIL_HR
    late_arrival = DEFAULT_LATE_ARRIVAL_UTILITY_UTIL_HR

    if isinstance(path_or_stream, str):
        fobj = open_maybe_gzip_path(path_or_stream)
    else:
        fobj = open_maybe_gzip_stream(path_or_stream)

    with fobj as f:
        tree = ET.parse(f)

    root = tree.getroot()
    for elem in root.iter():
        if _local_name(elem.tag) != "param":
            continue
        name = elem.attrib.get("name")
        if name in {"marginalUtilityOfMoney", "marginalUtilityOfMoney_util_money"}:
            marginal_utility_of_money = _coerce_float(elem.attrib.get("value"), marginal_utility_of_money)
        elif name == "performing":
            performing = _coerce_float(elem.attrib.get("value"), performing)
        elif name == "waitingPt":
            waiting_pt = _coerce_float(elem.attrib.get("value"), waiting_pt)
        elif name == "lateArrival":
            late_arrival = _coerce_float(elem.attrib.get("value"), late_arrival)

    for ps in root.iter():
        if _local_name(ps.tag) != "parameterset" or ps.attrib.get("type") != "modeParams":
            continue

        raw: Dict[str, str] = {}
        for child in ps:
            if _local_name(child.tag) != "param":
                continue
            name = child.attrib.get("name")
            if name:
                raw[name] = child.attrib.get("value", "")

        mode = str(raw.get("mode") or "").strip()
        if not mode:
            continue

        merged = dict(DEFAULT_MODE_PARAMS.get(mode, DEFAULT_MODE_PARAMS.get("other", _empty_mode_params())))
        for key in _empty_mode_params().keys():
            if key in raw:
                merged[key] = _coerce_float(raw.get(key), merged.get(key, 0.0))
        mode_params[mode] = merged

    for ps in root.iter():
        if _local_name(ps.tag) != "parameterset" or ps.attrib.get("type") != "activityParams":
            continue

        raw: Dict[str, str] = {}
        for child in ps:
            if _local_name(child.tag) != "param":
                continue
            name = child.attrib.get("name")
            if name:
                raw[name] = child.attrib.get("value", "")

        activity_type = str(raw.get("activityType") or "").strip()
        if not activity_type:
            continue

        params = _empty_activity_params()
        params["activityType"] = activity_type
        params["closingTimeSec"] = _parse_config_time_to_sec(raw.get("closingTime"))
        params["earliestEndTimeSec"] = _parse_config_time_to_sec(raw.get("earliestEndTime"))
        params["latestStartTimeSec"] = _parse_config_time_to_sec(raw.get("latestStartTime"))
        params["minimalDurationSec"] = _parse_config_time_to_sec(raw.get("minimalDuration"))
        params["openingTimeSec"] = _parse_config_time_to_sec(raw.get("openingTime"))
        params["priority"] = _coerce_float(raw.get("priority"), 1.0)
        params["scoringThisActivityAtAll"] = _coerce_bool(raw.get("scoringThisActivityAtAll"), True)
        params["typicalDurationSec"] = _parse_config_time_to_sec(raw.get("typicalDuration"))
        params["typicalDurationScoreComputation"] = raw.get("typicalDurationScoreComputation") or "relative"
        activity_params[activity_type] = params

    return {
        "modeParams": mode_params,
        "activityParams": activity_params,
        "marginalUtilityOfMoney": marginal_utility_of_money,
        "waitingPtUtility_util_hr": float(waiting_pt),
        "performingUtility_util_hr": float(performing),
        "lateArrivalUtility_util_hr": float(late_arrival),
    }


def _mode_params_for(
    mode: Any,
    mode_params: Optional[Dict[str, Dict[str, float]]] = None,
) -> Dict[str, float]:
    params = mode_params or DEFAULT_MODE_PARAMS
    mode_key = str(mode or "other")
    if mode_key in params:
        return params[mode_key]
    if mode_key == "bus" and "pt" in params:
        return params["pt"]
    return params.get("other", DEFAULT_MODE_PARAMS["other"])


def _step_distance_m(step: Dict[str, Any]) -> float:
    for key in ("distanceM", "distance", "routeDistance", "networkDistance"):
        value = step.get(key)
        if value not in (None, ""):
            return _coerce_float(value, 0.0)
    return 0.0


def _activity_params_for(
    activity_type: Any,
    activity_params: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    params = activity_params or {}
    act_type = str(activity_type or "")
    if act_type in params:
        return params[act_type]
    return None


def _activity_duration_sec(step: Dict[str, Any]) -> float:
    return max(0.0, _coerce_float(step.get("durationSec"), 0.0))


def _activity_score(
    step: Dict[str, Any],
    activity_params: Optional[Dict[str, Dict[str, Any]]],
    *,
    performing_utility_util_hr: float,
    waiting_pt_utility_util_hr: float,
    late_arrival_utility_util_hr: float,
) -> float:
    act_type = str(step.get("type") or "")
    duration_sec = _activity_duration_sec(step)
    duration_hr = duration_sec / 3600.0
    score = 0.0

    if act_type.lower() == "waitingpt":
        score += duration_hr * waiting_pt_utility_util_hr

    params = _activity_params_for(act_type, activity_params)
    if not params or not bool(params.get("scoringThisActivityAtAll", True)):
        return score

    typical_sec = params.get("typicalDurationSec")
    priority = _coerce_float(params.get("priority"), 1.0)
    if duration_sec > 0.0 and typical_sec and float(typical_sec) > 0.0 and priority > 0.0:
        typical_hr = float(typical_sec) / 3600.0
        denominator = float(typical_sec) * math.exp(-1.0 / priority)
        if denominator > 0.0:
            score += performing_utility_util_hr * typical_hr * math.log(duration_sec / denominator)

    latest_start_sec = params.get("latestStartTimeSec")
    actual_start_sec = parse_time_to_seconds(step.get("startTime"))
    if latest_start_sec is not None and actual_start_sec is not None:
        late_sec = max(0.0, float(actual_start_sec) - float(latest_start_sec))
        score += late_arrival_utility_util_hr * (late_sec / 3600.0)

    return score


def score_plan(
    steps: List[Dict[str, Any]],
    mode_params: Optional[Dict[str, Dict[str, float]]] = None,
    *,
    activity_params: Optional[Dict[str, Dict[str, Any]]] = None,
    marginal_utility_of_money: float = DEFAULT_MARGINAL_UTILITY_OF_MONEY,
    performing_utility_util_hr: float = DEFAULT_PERFORMING_UTILITY_UTIL_HR,
    waiting_pt_utility_util_hr: float = DEFAULT_WAITING_PT_UTILITY_UTIL_HR,
    late_arrival_utility_util_hr: float = DEFAULT_LATE_ARRIVAL_UTILITY_UTIL_HR,
) -> float:
    score = 0.0
    charged_daily_modes: set[str] = set()
    for s in steps:
        if s.get("kind") == "activity":
            score += _activity_score(
                s,
                activity_params,
                performing_utility_util_hr=performing_utility_util_hr,
                waiting_pt_utility_util_hr=waiting_pt_utility_util_hr,
                late_arrival_utility_util_hr=late_arrival_utility_util_hr,
            )
            continue

        if s.get("kind") != "leg":
            continue

        mode = str(s.get("mode") or "other")
        params = _mode_params_for(mode, mode_params)
        duration_hr = _coerce_float(s.get("durationSec"), 0.0) / 3600.0
        distance_m = _step_distance_m(s)

        score += params.get("constant", 0.0)
        score += duration_hr * params.get("marginalUtilityOfTraveling_util_hr", 0.0)
        score += distance_m * params.get("marginalUtilityOfDistance_util_m", 0.0)
        score += distance_m * params.get("monetaryDistanceRate", 0.0) * marginal_utility_of_money

        if mode not in charged_daily_modes:
            score += params.get("dailyUtilityConstant", 0.0)
            score += params.get("dailyMonetaryConstant", 0.0) * marginal_utility_of_money
            charged_daily_modes.add(mode)
    return score


def _apply_route_to_leg(step: Dict[str, Any], elem: ET.Element) -> None:
    step["routeType"] = elem.attrib.get("type")
    step["ptStartLink"] = elem.attrib.get("start_link")
    step["ptEndLink"] = elem.attrib.get("end_link")
    distance = safe_float(elem.attrib.get("distance") or elem.attrib.get("dist"))
    if distance is not None:
        step["distanceM"] = distance

    txt = (elem.text or "").strip()
    if not txt:
        return
    try:
        payload = json.loads(txt)
    except Exception:
        return
    if not isinstance(payload, dict):
        return

    tri = payload.get("transitRouteId")
    tli = payload.get("transitLineId")
    if tri:
        step["transitRouteId"] = tri
    if tli:
        step["transitLineId"] = tli
    for key in ("boardingTime", "accessFacilityId", "egressFacilityId"):
        if payload.get(key) is not None:
            step[key] = payload.get(key)
    for key in ("distance", "distanceM", "routeDistance", "networkDistance"):
        distance_val = safe_float(str(payload.get(key))) if payload.get(key) is not None else None
        if distance_val is not None:
            step["distanceM"] = distance_val
            break


def _plan_pt_metadata(steps: List[Dict[str, Any]]) -> tuple[bool, List[str]]:
    has_pt = False
    route_ids: set[str] = set()
    for step in steps:
        if not isinstance(step, dict):
            continue
        if step.get("kind") != "leg" or step.get("mode") not in ("pt", "bus"):
            continue
        has_pt = True
        rid = step.get("transitRouteId") or step.get("transitLineId") or step.get("ptStartLink")
        if rid not in (None, ""):
            route_ids.add(str(rid))
    return has_pt, sorted(route_ids)


def _annotate_person_metadata(person: Dict[str, Any]) -> None:
    plans = person.get("plans") or []
    if not isinstance(plans, list) or not plans:
        return

    best_idx = 0
    best_val = float("-inf")
    has_pt = False
    person_route_ids: set[str] = set()

    for idx, plan in enumerate(plans):
        if not isinstance(plan, dict):
            continue

        score = float(plan.get("serverScore") or 0.0)
        if score > best_val:
            best_val = score
            best_idx = idx

        plan_has_pt = plan.get("hasPt")
        plan_route_ids = plan.get("routeIds")
        if not isinstance(plan_has_pt, bool) or not isinstance(plan_route_ids, list):
            plan_has_pt, route_ids = _plan_pt_metadata(plan.get("steps") or [])
            plan["hasPt"] = plan_has_pt
            plan["routeIds"] = route_ids
            plan_route_ids = route_ids

        if plan_has_pt:
            has_pt = True
        for rid in plan_route_ids:
            if rid not in (None, ""):
                person_route_ids.add(str(rid))

    person["bestServerScorePlanIndex"] = best_idx
    person["hasPt"] = has_pt
    person["routeIds"] = sorted(person_route_ids)


def parse_plans_to_json(
    path_or_stream: Union[str, io.BufferedReader],
    facilities: Optional[Union[str, io.BufferedReader]] = None,
    max_persons: int = 200,
    selected_only_flag: bool = True,
    scoring_config: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    facilities_map = {}
    if facilities:
        try:
            facilities_map = parse_facilities_file(facilities)
        except Exception:
            facilities_map = {}

    scoring_config = scoring_config or {}
    mode_params = scoring_config.get("modeParams") or DEFAULT_MODE_PARAMS
    activity_params = scoring_config.get("activityParams") or {}
    marginal_utility_of_money = _coerce_float(
        scoring_config.get("marginalUtilityOfMoney"),
        DEFAULT_MARGINAL_UTILITY_OF_MONEY,
    )
    waiting_pt_utility = _coerce_float(
        scoring_config.get("waitingPtUtility_util_hr"),
        DEFAULT_WAITING_PT_UTILITY_UTIL_HR,
    )
    performing_utility = _coerce_float(
        scoring_config.get("performingUtility_util_hr"),
        DEFAULT_PERFORMING_UTILITY_UTIL_HR,
    )
    late_arrival_utility = _coerce_float(
        scoring_config.get("lateArrivalUtility_util_hr"),
        DEFAULT_LATE_ARRIVAL_UTILITY_UTIL_HR,
    )

    if isinstance(path_or_stream, str):
        fobj = open_maybe_gzip_path(path_or_stream)
    else:
        fobj = open_maybe_gzip_stream(path_or_stream)

    persons: List[Dict[str, Any]] = []
    current_person: Optional[Dict[str, Any]] = None
    selected_plan_obj: Optional[Dict[str, Any]] = None
    first_plan_obj: Optional[Dict[str, Any]] = None
    inside_plan = False
    plan_selected_flag = False
    plan_matsim_score: Optional[float] = None
    steps: List[Dict[str, Any]] = []
    last_open_activity_idx: Optional[int] = None
    current_time: Optional[str] = None
    last_leg_arrival: Optional[str] = None
    current_leg_idx: Optional[int] = None

    with fobj as f:
        context = ET.iterparse(f, events=("start", "end"))
        for event, elem in context:
            tag = elem.tag
            if event == "start":
                if tag == "person":
                    current_person = {"personId": elem.attrib.get("id"), "plans": []}
                    selected_plan_obj = None
                    first_plan_obj = None
                elif tag == "plan" and current_person is not None:
                    inside_plan = True
                    plan_selected_flag = (elem.attrib.get("selected") == "yes")
                    plan_matsim_score = safe_float(elem.attrib.get("score"))
                    steps = []
                    last_open_activity_idx = None
                    current_time = None
                    last_leg_arrival = None
                elif inside_plan and tag in ("act", "activity") and current_person is not None:
                    act_type = elem.attrib.get("type")
                    start_time = elem.attrib.get("start_time")
                    end_time = elem.attrib.get("end_time")
                    max_dur = elem.attrib.get("max_dur")
                    facility_id = elem.attrib.get("facility")
                    x = elem.attrib.get("x")
                    y = elem.attrib.get("y")
                    if (x is None or y is None) and facility_id and facilities_map:
                        xy = facilities_map.get(facility_id)
                        if xy:
                            x, y = xy
                    st = start_time or current_time or "00:00:00"
                    step: Dict[str, Any] = {
                        "kind": "activity",
                        "type": act_type,
                        "startTime": st,
                        "endTime": end_time,
                        "x": float(x) if x not in (None, "") else None,
                        "y": float(y) if y not in (None, "") else None,
                        "durationSec": None
                    }
                    steps.append(step)
                    last_open_activity_idx = len(steps) - 1
                    if end_time:
                        current_time = end_time
                    elif max_dur:
                        st_s = parse_time_to_seconds(st)
                        md_s = parse_time_to_seconds(max_dur)
                        if st_s is not None and md_s is not None:
                            et_s = st_s + md_s
                            step["endTime"] = sec_to_time(et_s)
                            current_time = step["endTime"]
                elif inside_plan and tag == "leg" and current_person is not None:
                    mode = elem.attrib.get("mode")
                    dep_time = elem.attrib.get("dep_time") or elem.attrib.get("depTime")
                    trav_time = elem.attrib.get("trav_time") or elem.attrib.get("travTime")
                    if last_open_activity_idx is not None and dep_time:
                        prev_act = steps[last_open_activity_idx]
                        if prev_act.get("endTime") in (None, ""):
                            prev_act["endTime"] = dep_time
                    dt = dep_time or current_time or "00:00:00"
                    step: Dict[str, Any] = {
                        "kind": "leg",
                        "mode": mode,
                        "depTime": dt,
                        "travelTime": trav_time,
                        "durationSec": None
                    }
                    steps.append(step)
                    current_leg_idx = len(steps) - 1
                    dep_s = parse_time_to_seconds(dt)
                    tt_s = parse_time_to_seconds(trav_time) if trav_time else None
                    if dep_s is not None and tt_s is not None:
                        arr_s = dep_s + tt_s
                        last_leg_arrival = sec_to_time(arr_s)
                        current_time = last_leg_arrival
                elif inside_plan and tag == "route" and current_leg_idx is not None and 0 <= current_leg_idx < len(steps):
                    steps[current_leg_idx]["routeType"] = elem.attrib.get("type")
                    steps[current_leg_idx]["ptStartLink"] = elem.attrib.get("start_link")
                    steps[current_leg_idx]["ptEndLink"] = elem.attrib.get("end_link")
                    distance = safe_float(elem.attrib.get("distance") or elem.attrib.get("dist"))
                    if distance is not None:
                        steps[current_leg_idx]["distanceM"] = distance
            elif event == "end":
                if tag == "route" and current_leg_idx is not None and 0 <= current_leg_idx < len(steps):
                    _apply_route_to_leg(steps[current_leg_idx], elem)
                if tag == "leg":
                    current_leg_idx = None
                if tag == "plan" and inside_plan:
                    for i, s in enumerate(steps):
                        if s["kind"] == "activity":
                            st_s = parse_time_to_seconds(s.get("startTime"))
                            et = s.get("endTime")
                            if et is None:
                                found: Optional[str] = None
                                for j in range(i + 1, len(steps)):
                                    n = steps[j]
                                    if n["kind"] == "leg" and n.get("depTime"):
                                        found = n.get("depTime")
                                        break
                                    if n["kind"] == "activity" and n.get("startTime"):
                                        found = n.get("startTime")
                                        break
                                if found:
                                    s["endTime"] = found
                                elif last_leg_arrival:
                                    s["endTime"] = last_leg_arrival
                            et_s = parse_time_to_seconds(s.get("endTime"))
                            s["durationSec"] = (et_s - st_s) if (st_s is not None and et_s is not None) else None
                        else:
                            tt_s = parse_time_to_seconds(s.get("travelTime"))
                            s["durationSec"] = tt_s if tt_s is not None else None
                    server_score = score_plan(
                        steps,
                        mode_params,
                        activity_params=activity_params,
                        marginal_utility_of_money=marginal_utility_of_money,
                        performing_utility_util_hr=performing_utility,
                        waiting_pt_utility_util_hr=waiting_pt_utility,
                        late_arrival_utility_util_hr=late_arrival_utility,
                    )
                    plan_has_pt, plan_route_ids = _plan_pt_metadata(steps)
                    if current_person is not None:
                        plan_obj = {
                            "selected": plan_selected_flag,
                            "matsimScore": plan_matsim_score,
                            "serverScore": server_score,
                            "scoreModel": "matsim-scoring-params",
                            "waitingPtUtilityUtilHr": waiting_pt_utility,
                            "steps": steps,
                            "hasPt": plan_has_pt,
                            "routeIds": plan_route_ids,
                        }
                        if selected_only_flag:
                            if first_plan_obj is None:
                                first_plan_obj = plan_obj
                            if plan_selected_flag:
                                selected_plan_obj = plan_obj
                        else:
                            current_person["plans"].append(plan_obj)
                    inside_plan = False
                    plan_selected_flag = False
                    plan_matsim_score = None
                    steps = []
                    last_open_activity_idx = None
                    current_time = None
                    last_leg_arrival = None
                elif tag == "person" and current_person is not None:
                    if selected_only_flag:
                        plan_obj = selected_plan_obj or first_plan_obj
                        if plan_obj is not None:
                            current_person["plans"] = [plan_obj]
                            current_person["selectedPlanIndex"] = 0
                            _annotate_person_metadata(current_person)
                            persons.append(current_person)
                    else:
                        sel_idx = 0
                        for i, pl in enumerate(current_person["plans"]):
                            if pl.get("selected"):
                                sel_idx = i
                                break
                        current_person["selectedPlanIndex"] = sel_idx
                        if current_person["plans"]:
                            _annotate_person_metadata(current_person)
                            persons.append(current_person)
                    current_person = None
                    elem.clear()
                    if len(persons) >= max_persons:
                        break
    return persons


def iter_plans_to_persons(
    path_or_stream: Union[str, io.BufferedReader],
    facilities: Optional[Union[str, io.BufferedReader]] = None,
    max_persons: int = 200,
    selected_only_flag: bool = True,
    scoring_config: Optional[Dict[str, Any]] = None,
) -> Iterator[Dict[str, Any]]:
    """
    Streaming variant of `parse_plans_to_json` that yields persons one-by-one
    to avoid holding large datasets in memory.
    """
    facilities_map = {}
    if facilities:
        try:
            facilities_map = parse_facilities_file(facilities)
        except Exception:
            facilities_map = {}

    scoring_config = scoring_config or {}
    mode_params = scoring_config.get("modeParams") or DEFAULT_MODE_PARAMS
    activity_params = scoring_config.get("activityParams") or {}
    marginal_utility_of_money = _coerce_float(
        scoring_config.get("marginalUtilityOfMoney"),
        DEFAULT_MARGINAL_UTILITY_OF_MONEY,
    )
    waiting_pt_utility = _coerce_float(
        scoring_config.get("waitingPtUtility_util_hr"),
        DEFAULT_WAITING_PT_UTILITY_UTIL_HR,
    )
    performing_utility = _coerce_float(
        scoring_config.get("performingUtility_util_hr"),
        DEFAULT_PERFORMING_UTILITY_UTIL_HR,
    )
    late_arrival_utility = _coerce_float(
        scoring_config.get("lateArrivalUtility_util_hr"),
        DEFAULT_LATE_ARRIVAL_UTILITY_UTIL_HR,
    )

    if isinstance(path_or_stream, str):
        fobj = open_maybe_gzip_path(path_or_stream)
    else:
        fobj = open_maybe_gzip_stream(path_or_stream)

    yielded = 0
    current_person: Optional[Dict[str, Any]] = None
    selected_plan_obj: Optional[Dict[str, Any]] = None
    first_plan_obj: Optional[Dict[str, Any]] = None
    inside_plan = False
    plan_selected_flag = False
    plan_matsim_score: Optional[float] = None
    steps: List[Dict[str, Any]] = []
    last_open_activity_idx: Optional[int] = None
    current_time: Optional[str] = None
    last_leg_arrival: Optional[str] = None
    current_leg_idx: Optional[int] = None

    with fobj as f:
        context = ET.iterparse(f, events=("start", "end"))
        for event, elem in context:
            tag = elem.tag
            if event == "start":
                if tag == "person":
                    current_person = {"personId": elem.attrib.get("id"), "plans": []}
                    selected_plan_obj = None
                    first_plan_obj = None
                elif tag == "plan" and current_person is not None:
                    inside_plan = True
                    plan_selected_flag = (elem.attrib.get("selected") == "yes")
                    plan_matsim_score = safe_float(elem.attrib.get("score"))
                    steps = []
                    last_open_activity_idx = None
                    current_time = None
                    last_leg_arrival = None
                elif inside_plan and tag in ("act", "activity") and current_person is not None:
                    act_type = elem.attrib.get("type")
                    start_time = elem.attrib.get("start_time")
                    end_time = elem.attrib.get("end_time")
                    max_dur = elem.attrib.get("max_dur")
                    facility_id = elem.attrib.get("facility")
                    x = elem.attrib.get("x")
                    y = elem.attrib.get("y")
                    if (x is None or y is None) and facility_id and facilities_map:
                        xy = facilities_map.get(facility_id)
                        if xy:
                            x, y = str(xy[0]), str(xy[1])
                    if start_time:
                        current_time = start_time
                    elif current_time is None:
                        current_time = "00:00:00"
                    step: Dict[str, Any] = {
                        "kind": "activity",
                        "type": act_type,
                        "startTime": start_time or current_time,
                        "endTime": end_time,
                        "maxDur": max_dur,
                        "facility": facility_id,
                        "x": safe_float(x),
                        "y": safe_float(y),
                        "durationSec": None,
                    }
                    steps.append(step)
                    last_open_activity_idx = len(steps) - 1
                    if end_time:
                        current_time = end_time
                elif inside_plan and tag == "leg" and current_person is not None:
                    mode = elem.attrib.get("mode")
                    dep = elem.attrib.get("dep_time")
                    trav_time = elem.attrib.get("trav_time")
                    dt = dep or current_time or "00:00:00"
                    step = {
                        "kind": "leg",
                        "mode": mode,
                        "depTime": dt,
                        "travelTime": trav_time,
                        "durationSec": None,
                    }
                    steps.append(step)
                    current_leg_idx = len(steps) - 1
                    dep_s = parse_time_to_seconds(dt)
                    tt_s = parse_time_to_seconds(trav_time) if trav_time else None
                    if dep_s is not None and tt_s is not None:
                        arr_s = dep_s + tt_s
                        last_leg_arrival = sec_to_time(arr_s)
                        current_time = last_leg_arrival
                elif inside_plan and tag == "route" and current_leg_idx is not None and 0 <= current_leg_idx < len(steps):
                    steps[current_leg_idx]["routeType"] = elem.attrib.get("type")
                    steps[current_leg_idx]["ptStartLink"] = elem.attrib.get("start_link")
                    steps[current_leg_idx]["ptEndLink"] = elem.attrib.get("end_link")
                    distance = safe_float(elem.attrib.get("distance") or elem.attrib.get("dist"))
                    if distance is not None:
                        steps[current_leg_idx]["distanceM"] = distance
            elif event == "end":
                if tag == "route" and current_leg_idx is not None and 0 <= current_leg_idx < len(steps):
                    _apply_route_to_leg(steps[current_leg_idx], elem)
                if tag == "leg":
                    current_leg_idx = None
                if tag == "plan" and inside_plan:
                    for i, s in enumerate(steps):
                        if s.get("kind") == "activity":
                            st_s = parse_time_to_seconds(s.get("startTime"))
                            et = s.get("endTime")
                            if et is None:
                                found: Optional[str] = None
                                for j in range(i + 1, len(steps)):
                                    n = steps[j]
                                    if n.get("kind") == "leg" and n.get("depTime"):
                                        found = n.get("depTime")
                                        break
                                    if n.get("kind") == "activity" and n.get("startTime"):
                                        found = n.get("startTime")
                                        break
                                if found:
                                    s["endTime"] = found
                                elif last_leg_arrival:
                                    s["endTime"] = last_leg_arrival
                            et_s = parse_time_to_seconds(s.get("endTime"))
                            s["durationSec"] = (et_s - st_s) if (st_s is not None and et_s is not None) else None
                        else:
                            tt_s = parse_time_to_seconds(s.get("travelTime"))
                            s["durationSec"] = tt_s if tt_s is not None else None

                    server_score = score_plan(
                        steps,
                        mode_params,
                        activity_params=activity_params,
                        marginal_utility_of_money=marginal_utility_of_money,
                        performing_utility_util_hr=performing_utility,
                        waiting_pt_utility_util_hr=waiting_pt_utility,
                        late_arrival_utility_util_hr=late_arrival_utility,
                    )
                    plan_has_pt, plan_route_ids = _plan_pt_metadata(steps)
                    if current_person is not None:
                        plan_obj = {
                            "selected": plan_selected_flag,
                            "matsimScore": plan_matsim_score,
                            "serverScore": server_score,
                            "scoreModel": "matsim-scoring-params",
                            "waitingPtUtilityUtilHr": waiting_pt_utility,
                            "steps": steps,
                            "hasPt": plan_has_pt,
                            "routeIds": plan_route_ids,
                        }
                        if selected_only_flag:
                            if first_plan_obj is None:
                                first_plan_obj = plan_obj
                            if plan_selected_flag:
                                selected_plan_obj = plan_obj
                        else:
                            current_person["plans"].append(plan_obj)

                    inside_plan = False
                    plan_selected_flag = False
                    plan_matsim_score = None
                    steps = []
                    last_open_activity_idx = None
                    current_time = None
                    last_leg_arrival = None

                elif tag == "person" and current_person is not None:
                    if selected_only_flag:
                        plan_obj = selected_plan_obj or first_plan_obj
                        if plan_obj is not None:
                            current_person["plans"] = [plan_obj]
                            current_person["selectedPlanIndex"] = 0
                            _annotate_person_metadata(current_person)
                            yield current_person
                            yielded += 1
                    else:
                        sel_idx = 0
                        for i, pl in enumerate(current_person.get("plans") or []):
                            if isinstance(pl, dict) and pl.get("selected"):
                                sel_idx = i
                                break
                        current_person["selectedPlanIndex"] = sel_idx
                        if current_person.get("plans"):
                            _annotate_person_metadata(current_person)
                            yield current_person
                            yielded += 1

                    current_person = None
                    elem.clear()
                    if yielded >= max_persons:
                        break
