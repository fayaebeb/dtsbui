import gzip
import json
import io
import os
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Union


def parse_time_to_seconds(time_str: Optional[str]) -> Optional[int]:
    if not time_str:
        return None
    try:
        h, m, s = time_str.split(":")
        return int(h) * 3600 + int(m) * 60 + int(s)
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


DEFAULT_WEIGHTS = {
    "act": {"Home": 1.0, "Work": 0.5, "Business": 0.3, "Shopping": 0.2, "__other__": 0.1},
    "leg": {"car": -2.0, "walk": 0.5, "pt": 0.1, "__other__": 0.0},
}


def score_plan(steps: List[Dict[str, Any]], weights=DEFAULT_WEIGHTS) -> float:
    score = 0.0
    for s in steps:
        if s.get("kind") == "activity":
            w = weights["act"].get(s.get("type"), weights["act"]["__other__"])
            score += (s.get("durationSec") or 0) * w
        elif s.get("kind") == "leg":
            w = weights["leg"].get(s.get("mode"), weights["leg"]["__other__"])
            score += (s.get("durationSec") or 0) * w
    return score


def parse_plans_to_json(path_or_stream: Union[str, io.BufferedReader], facilities: Optional[Union[str, io.BufferedReader]] = None, max_persons: int = 200, selected_only_flag: bool = True) -> List[Dict[str, Any]]:
    facilities_map = {}
    if facilities:
        try:
            facilities_map = parse_facilities_file(facilities)
        except Exception:
            facilities_map = {}

    if isinstance(path_or_stream, str):
        fobj = open_maybe_gzip_path(path_or_stream)
    else:
        fobj = open_maybe_gzip_stream(path_or_stream)

    persons: List[Dict[str, Any]] = []
    current_person: Optional[Dict[str, Any]] = None
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
                    # Capture PT route metadata embedded in the leg's <route> element
                    # Example:
                    # <route type="default_pt" start_link="..." end_link="...">{ "transitRouteId": "...", ... }</route>
                    try:
                        steps[current_leg_idx]["routeType"] = elem.attrib.get("type")
                        steps[current_leg_idx]["ptStartLink"] = elem.attrib.get("start_link")
                        steps[current_leg_idx]["ptEndLink"] = elem.attrib.get("end_link")
                        txt = (elem.text or "").strip()
                        if txt:
                            try:
                                payload = json.loads(txt)
                                if isinstance(payload, dict):
                                    tri = payload.get("transitRouteId")
                                    tli = payload.get("transitLineId")
                                    if tri:
                                        steps[current_leg_idx]["transitRouteId"] = tri
                                    if tli:
                                        steps[current_leg_idx]["transitLineId"] = tli
                                    # Optionally persist a few other PT attributes if present
                                    for k in ("boardingTime", "accessFacilityId", "egressFacilityId"):
                                        if payload.get(k) is not None:
                                            steps[current_leg_idx][k] = payload.get(k)
                            except Exception:
                                # Ignore malformed JSON inside <route>
                                pass
                    except Exception:
                        pass
            elif event == "end":
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
                    server_score = score_plan(steps, DEFAULT_WEIGHTS)
                    if current_person is not None:
                        plan_obj = {
                            "selected": plan_selected_flag,
                            "matsimScore": plan_matsim_score,
                            "serverScore": server_score,
                            "steps": steps
                        }
                        current_person["plans"].append(plan_obj)
                    inside_plan = False
                    plan_selected_flag = False
                    plan_matsim_score = None
                    steps = []
                    last_open_activity_idx = None
                    current_time = None
                    last_leg_arrival = None
                elif tag == "person" and current_person is not None:
                    sel_idx = 0
                    for i, pl in enumerate(current_person["plans"]):
                        if pl.get("selected"):
                            sel_idx = i
                            break
                    current_person["selectedPlanIndex"] = sel_idx
                    if selected_only_flag and current_person["plans"]:
                        current_person["plans"] = [current_person["plans"][sel_idx]]
                    if current_person["plans"]:
                        persons.append(current_person)
                    current_person = None
                    elem.clear()
                    if len(persons) >= max_persons:
                        break
    return persons
