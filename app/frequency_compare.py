from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from .aggregates import Aggregator

DEFAULT_WAITING_PT_COEFF_UTIL_HR = -2.3394


def _best_index_by_server_score(plans: List[Dict[str, Any]]) -> int:
    if not plans:
        return 0
    best = 0
    best_val = float(plans[0].get("serverScore") or 0.0)
    for i in range(1, len(plans)):
        v = float(plans[i].get("serverScore") or 0.0)
        if v > best_val:
            best_val = v
            best = i
    return best


def _is_pt_leg(step: Dict[str, Any]) -> bool:
    return step.get("kind") == "leg" and step.get("mode") in ("pt", "bus")


def _supports_transit_route_ids(steps: List[Dict[str, Any]]) -> bool:
    # Mirror route_sim.js: if any pt leg contains transitRouteId key, treat the dataset as supporting ids.
    for s in steps:
        if not isinstance(s, dict):
            continue
        if _is_pt_leg(s) and "transitRouteId" in s:
            return True
    return False


def _best_index_for_person(person: Dict[str, Any], plans: List[Dict[str, Any]]) -> int:
    idx = person.get("bestServerScorePlanIndex")
    if isinstance(idx, int) and 0 <= idx < len(plans):
        return idx
    return _best_index_by_server_score(plans)


def _plan_cached_route_ids(plan: Dict[str, Any]) -> List[str]:
    route_ids = plan.get("routeIds")
    if isinstance(route_ids, list):
        return [str(rid) for rid in route_ids if rid not in (None, "")]
    return []


def _plan_affected_by_route(plan: Dict[str, Any], route_id: str) -> bool:
    route_ids = _plan_cached_route_ids(plan)
    if route_ids:
        if not route_id:
            return True
        return route_id in route_ids

    has_pt = plan.get("hasPt")
    if isinstance(has_pt, bool) and not has_pt:
        return False

    steps = plan.get("steps") or []
    if not isinstance(steps, list):
        return False
    steps = [s for s in steps if isinstance(s, dict)]
    has_any_pt = any(_is_pt_leg(s) for s in steps)
    supports_ids = _supports_transit_route_ids(steps)
    if not route_id:
        return has_any_pt
    has_exact = any(_is_pt_leg(s) and s.get("transitRouteId") == route_id for s in steps)
    return has_exact if supports_ids else has_any_pt


def _plan_has_any_brt_leg(plan: Dict[str, Any]) -> bool:
    steps = plan.get("steps") or []
    if isinstance(steps, list):
        if any(isinstance(s, dict) and _is_pt_leg(s) for s in steps):
            return True

    has_pt = plan.get("hasPt")
    return bool(has_pt) if isinstance(has_pt, bool) else False


def _person_compare_payload(
    *,
    person_id: str,
    before_idx: int,
    after_idx: int,
    before_score: float,
    after_score: float,
    before_plan: Dict[str, Any],
    after_plan: Dict[str, Any],
    route_id: str,
    include_steps: bool,
) -> Dict[str, Any]:
    before_uses_brt = _plan_has_any_brt_leg(before_plan)
    after_uses_brt = _plan_affected_by_route(after_plan, route_id)
    payload: Dict[str, Any] = {
        "personId": person_id,
        "beforePlanIndex": int(before_idx),
        "afterPlanIndex": int(after_idx),
        "beforeScore": before_score,
        "afterScore": after_score,
        "deltaScore": float(after_score - before_score),
        "changedPlan": bool(after_idx != before_idx),
        "beforeUsesBrt": bool(before_uses_brt),
        "afterUsesBrt": bool(after_uses_brt),
    }
    if include_steps:
        payload["beforePlanSteps"] = before_plan.get("steps") or []
        payload["afterPlanSteps"] = after_plan.get("steps") or []
    return payload


def _story_candidate_rank(payload: Dict[str, Any]) -> tuple[int, float]:
    if not payload.get("afterUsesBrt"):
        return (0, float(payload.get("deltaScore") or 0.0))
    if not payload.get("beforeUsesBrt"):
        return (3, float(payload.get("deltaScore") or 0.0))
    if payload.get("changedPlan"):
        return (2, float(payload.get("deltaScore") or 0.0))
    return (1, float(payload.get("deltaScore") or 0.0))


def _person_may_be_affected(person: Dict[str, Any], plans: List[Dict[str, Any]], route_id: str) -> bool:
    route_ids = person.get("routeIds")
    if isinstance(route_ids, list) and route_ids:
        route_id_set = {str(rid) for rid in route_ids if rid not in (None, "")}
        if not route_id:
            return True
        return route_id in route_id_set

    has_pt = person.get("hasPt")
    if isinstance(has_pt, bool):
        if not has_pt:
            return False
        if not route_id:
            return True

    return any(_plan_affected_by_route(plan, route_id) for plan in plans)


def _argmax(values: List[float]) -> int:
    if not values:
        return 0
    best = 0
    best_val = values[0]
    for i, v in enumerate(values):
        if v > best_val:
            best_val = v
            best = i
    return best


def _waiting_pt_duration_sec(plan: Dict[str, Any]) -> float:
    total = 0.0
    for step in plan.get("steps") or []:
        if not isinstance(step, dict):
            continue
        if step.get("kind") != "activity":
            continue
        if str(step.get("type") or "").lower() != "waitingpt":
            continue
        try:
            total += float(step.get("durationSec") or 0.0)
        except Exception:
            continue
    return total


def _waiting_pt_coeff_util_hr(plan: Dict[str, Any], fallback: float) -> float:
    try:
        return float(plan.get("waitingPtUtilityUtilHr"))
    except Exception:
        return float(fallback)


def _plan_frequency_delta_score(
    plan: Dict[str, Any],
    *,
    route_id: str,
    new_frequency: float,
    waiting_pt_coeff_util_hr: float,
) -> float:
    if not _plan_affected_by_route(plan, route_id):
        return 0.0

    current_wait_sec = _waiting_pt_duration_sec(plan)
    if current_wait_sec <= 0.0:
        return 0.0

    new_f = max(1.0, float(new_frequency or 0.0))
    expected_wait_after_sec = ((60.0 / new_f) / 2.0) * 60.0
    expected_change_hr = (expected_wait_after_sec - current_wait_sec) / 3600.0
    coeff = _waiting_pt_coeff_util_hr(plan, waiting_pt_coeff_util_hr)
    return expected_change_hr * coeff


def _reference_frequency_delta_score(
    *,
    old_frequency: float,
    new_frequency: float,
    waiting_pt_coeff_util_hr: float,
) -> float:
    old_f = max(1.0, float(old_frequency or 0.0))
    new_f = max(1.0, float(new_frequency or 0.0))
    expected_change_hr = (((60.0 / new_f) / 2.0) - ((60.0 / old_f) / 2.0)) / 60.0
    return expected_change_hr * float(waiting_pt_coeff_util_hr)


def _compare_person_frequency_change(
    person: Dict[str, Any],
    plans: List[Dict[str, Any]],
    *,
    route_id: str,
    new_frequency: float,
    waiting_pt_coeff_util_hr: float = DEFAULT_WAITING_PT_COEFF_UTIL_HR,
) -> tuple[int, int, float, float]:
    before_idx = _best_index_for_person(person, plans)
    before_score = float(plans[before_idx].get("serverScore") or 0.0) if 0 <= before_idx < len(plans) else 0.0

    if not _person_may_be_affected(person, plans, route_id):
        return before_idx, before_idx, before_score, before_score

    adjusted_scores: List[float] = []
    any_affected = False
    for pl in plans:
        base = float(pl.get("serverScore") or 0.0)
        delta = _plan_frequency_delta_score(
            pl,
            route_id=route_id,
            new_frequency=new_frequency,
            waiting_pt_coeff_util_hr=waiting_pt_coeff_util_hr,
        )
        any_affected = any_affected or abs(delta) > 1e-12
        adjusted_scores.append(base + delta)

    if not any_affected:
        return before_idx, before_idx, before_score, before_score

    after_idx = _argmax(adjusted_scores)
    after_score = adjusted_scores[after_idx] if 0 <= after_idx < len(adjusted_scores) else before_score
    return before_idx, after_idx, before_score, float(after_score)


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


def _ensure_len(lst: List[int], n: int) -> None:
    if n <= len(lst):
        return
    lst.extend([0] * (n - len(lst)))


def _station_plan_contribution(
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
        if not isinstance(step, dict):
            continue
        if step.get("kind") != "activity":
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


def _apply_station_contribution(counts: Dict[str, Any], contribution: Dict[str, Any], direction: int) -> None:
    if bool(contribution.get("visited")):
        counts["uniqueVisitors"] = max(0, int(counts.get("uniqueVisitors") or 0) + int(direction))

    bins = counts.setdefault("presentByBin", [])
    if not isinstance(bins, list):
        bins = []
        counts["presentByBin"] = bins
    for b in contribution.get("bins") or []:
        try:
            idx = int(b)
        except Exception:
            continue
        _ensure_len(bins, idx + 1)
        bins[idx] = max(0, int(bins[idx] or 0) + int(direction))

    if direction > 0:
        counts["maxTimeSec"] = max(int(counts.get("maxTimeSec") or 0), int(contribution.get("maxTimeSec") or 0))


def _accumulate_station_area_for_plan(
    person_id: str,
    plan: Dict[str, Any],
    *,
    center_x: float,
    center_y: float,
    radius_sq: float,
    bin_sec: int,
    present_by_bin: List[int],
    unique_visitors: set[str],
) -> int:
    contribution = _station_plan_contribution(
        plan,
        center_x=center_x,
        center_y=center_y,
        radius_sq=radius_sq,
        bin_sec=bin_sec,
    )
    if bool(contribution.get("visited")):
        unique_visitors.add(person_id)
    for b in contribution.get("bins") or []:
        try:
            idx = int(b)
        except Exception:
            continue
        _ensure_len(present_by_bin, idx + 1)
        present_by_bin[idx] += 1
    return int(contribution.get("maxTimeSec") or 0)


def compare_frequency(
    persons: Iterable[Dict[str, Any]],
    *,
    route_id: str,
    old_frequency: float,
    new_frequency: float,
    waiting_pt_coeff_util_hr: float = DEFAULT_WAITING_PT_COEFF_UTIL_HR,
) -> Dict[str, Any]:
    """
    Apply waitingPt-based frequency utility adjustment and
    return before/after selected plan indices per person (plus changed count).
    """
    old_f = max(1.0, float(old_frequency or 0.0))
    new_f = max(1.0, float(new_frequency or 0.0))
    delta_wait_min = ((60.0 / old_f) - (60.0 / new_f)) / 2.0
    delta_score = _reference_frequency_delta_score(
        old_frequency=old_f,
        new_frequency=new_f,
        waiting_pt_coeff_util_hr=waiting_pt_coeff_util_hr,
    )

    changed = 0
    before_indices: Dict[str, int] = {}
    after_indices: Dict[str, int] = {}

    for p in persons:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("personId") or "")
        plans = p.get("plans") or []
        if not isinstance(plans, list) or not plans:
            continue
        plans = [pl for pl in plans if isinstance(pl, dict)]
        if not plans:
            continue

        before_idx, after_idx, _before_score, _after_score = _compare_person_frequency_change(
            p,
            plans,
            route_id=route_id,
            new_frequency=new_f,
            waiting_pt_coeff_util_hr=waiting_pt_coeff_util_hr,
        )
        before_indices[pid] = before_idx
        after_indices[pid] = after_idx
        if after_idx != before_idx:
            changed += 1

    return {
        "routeId": route_id,
        "oldFrequency": old_f,
        "newFrequency": new_f,
        "deltaWaitMin": delta_wait_min,
        "deltaScore": delta_score,
        "changedPeople": changed,
        "beforePlanIndexByPerson": before_indices,
        "afterPlanIndexByPerson": after_indices,
    }


def compute_frequency_compare_aggregates_from_affected(
    persons: Iterable[Dict[str, Any]],
    *,
    baseline_state: Dict[str, Any],
    route_id: str,
    old_frequency: float,
    new_frequency: float,
    top_routes: int = 12,
    waiting_pt_coeff_util_hr: float = DEFAULT_WAITING_PT_COEFF_UTIL_HR,
    changed_sample_n: int = 50,
    include_most_impacted_steps: bool = False,
    station_baseline: Optional[Dict[str, Any]] = None,
    station_name: Optional[str] = None,
) -> Dict[str, Any]:
    old_f = max(1.0, float(old_frequency or 0.0))
    new_f = max(1.0, float(new_frequency or 0.0))
    delta_wait_min = ((60.0 / old_f) - (60.0 / new_f)) / 2.0
    delta_score = _reference_frequency_delta_score(
        old_frequency=old_f,
        new_frequency=new_f,
        waiting_pt_coeff_util_hr=waiting_pt_coeff_util_hr,
    )

    pre_agg = Aggregator.from_state(baseline_state or {})
    post_agg = Aggregator.from_state(baseline_state or {})
    pre_total_utility = float((baseline_state or {}).get("totalUtility") or 0.0)
    post_total_utility = pre_total_utility
    utility_people = int((baseline_state or {}).get("totalPeople") or 0)

    changed = 0
    changed_sample: List[Dict[str, Any]] = []
    most_impacted: Optional[Dict[str, Any]] = None
    story_target: Optional[Dict[str, Any]] = None
    most_delta = float("-inf")
    best_story_rank: tuple[int, float] = (0, float("-inf"))
    station_pre = None
    station_post = None
    station_enabled = isinstance(station_baseline, dict)
    if station_enabled:
        station_pre = {
            "uniqueVisitors": int(station_baseline.get("uniqueVisitors") or 0),
            "presentByBin": list(station_baseline.get("presentByBin") or []),
            "maxTimeSec": int(station_baseline.get("maxTimeSec") or 0),
        }
        station_post = {
            "uniqueVisitors": int(station_baseline.get("uniqueVisitors") or 0),
            "presentByBin": list(station_baseline.get("presentByBin") or []),
            "maxTimeSec": int(station_baseline.get("maxTimeSec") or 0),
        }
        station_center_x = float(station_baseline.get("centerX") or 0.0)
        station_center_y = float(station_baseline.get("centerY") or 0.0)
        station_radius_sq = float(station_baseline.get("radiusM") or 0.0) * float(station_baseline.get("radiusM") or 0.0)
        station_bin_sec = max(1, int(station_baseline.get("binSec") or 3600))

    for p in persons:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("personId") or "")
        plans = p.get("plans") or []
        if not isinstance(plans, list) or not plans:
            continue
        plans = [pl for pl in plans if isinstance(pl, dict)]
        if not plans:
            continue

        before_idx, after_idx, before_score, after_score = _compare_person_frequency_change(
            p,
            plans,
            route_id=route_id,
            new_frequency=new_f,
            waiting_pt_coeff_util_hr=waiting_pt_coeff_util_hr,
        )
        delta = after_score - before_score
        pre_plan = plans[before_idx] if 0 <= before_idx < len(plans) else plans[0]
        post_plan = plans[after_idx] if 0 <= after_idx < len(plans) else plans[0]
        person_payload = _person_compare_payload(
            person_id=pid,
            before_idx=before_idx,
            after_idx=after_idx,
            before_score=before_score,
            after_score=after_score,
            before_plan=pre_plan,
            after_plan=post_plan,
            route_id=route_id,
            include_steps=include_most_impacted_steps,
        )
        post_total_utility += delta

        if delta > most_delta:
            most_delta = delta
            most_impacted = person_payload

        story_rank = _story_candidate_rank(person_payload)
        if story_rank[0] > 0 and story_rank > best_story_rank:
            best_story_rank = story_rank
            story_target = person_payload

        if after_idx != before_idx:
            changed += 1
            if len(changed_sample) < max(0, int(changed_sample_n)):
                changed_sample.append({"personId": pid, "before": int(before_idx), "after": int(after_idx)})
            post_agg.remove_person_plan(pid, pre_plan)
            post_agg.add_person_plan(pid, post_plan)
            if station_enabled and station_post is not None:
                before_contribution = _station_plan_contribution(
                    pre_plan,
                    center_x=station_center_x,
                    center_y=station_center_y,
                    radius_sq=station_radius_sq,
                    bin_sec=station_bin_sec,
                )
                after_contribution = _station_plan_contribution(
                    post_plan,
                    center_x=station_center_x,
                    center_y=station_center_y,
                    radius_sq=station_radius_sq,
                    bin_sec=station_bin_sec,
                )
                _apply_station_contribution(station_post, before_contribution, -1)
                _apply_station_contribution(station_post, after_contribution, 1)

    pre_out = pre_agg.to_dict(top_routes=top_routes)
    post_out = post_agg.to_dict(top_routes=top_routes)
    if utility_people > 0:
        pre_out["totalUtility"] = pre_total_utility
        pre_out["avgUtility"] = pre_total_utility / utility_people
        post_out["totalUtility"] = post_total_utility
        post_out["avgUtility"] = post_total_utility / utility_people

    station_area = None
    if station_enabled and station_pre is not None and station_post is not None:
        station_area = {
            "stationName": station_name or station_baseline.get("stationName") or "",
            "centerX": float(station_baseline.get("centerX") or 0.0),
            "centerY": float(station_baseline.get("centerY") or 0.0),
            "radiusM": float(station_baseline.get("radiusM") or 0.0),
            "binSec": int(station_baseline.get("binSec") or 3600),
            "pre": station_pre,
            "post": station_post,
        }

    return {
        "routeId": route_id,
        "oldFrequency": old_f,
        "newFrequency": new_f,
        "deltaWaitMin": delta_wait_min,
        "deltaScore": delta_score,
        "changedPeople": changed,
        "changedSample": changed_sample,
        "mostImpacted": most_impacted,
        "storyTarget": story_target,
        "preAggregates": pre_out,
        "postAggregates": post_out,
        "stationArea": station_area,
    }


def compute_frequency_compare_aggregates(
    persons: Iterable[Dict[str, Any]],
    *,
    route_id: str,
    old_frequency: float,
    new_frequency: float,
    top_routes: int = 12,
    waiting_pt_coeff_util_hr: float = DEFAULT_WAITING_PT_COEFF_UTIL_HR,
    changed_sample_n: int = 50,
    include_most_impacted_steps: bool = False,
    station_center_x: Optional[float] = None,
    station_center_y: Optional[float] = None,
    station_radius_m: Optional[float] = None,
    station_bin_sec: int = 3600,
    station_name: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Compute post-change aggregates (over all persons) for a frequency adjustment,
    without materializing large per-person index maps.
    """
    old_f = max(1.0, float(old_frequency or 0.0))
    new_f = max(1.0, float(new_frequency or 0.0))
    delta_wait_min = ((60.0 / old_f) - (60.0 / new_f)) / 2.0
    delta_score = _reference_frequency_delta_score(
        old_frequency=old_f,
        new_frequency=new_f,
        waiting_pt_coeff_util_hr=waiting_pt_coeff_util_hr,
    )

    changed = 0
    changed_sample: List[Dict[str, Any]] = []

    pre_agg = Aggregator()
    post_agg = Aggregator()
    pre_total_utility = 0.0
    post_total_utility = 0.0
    utility_people = 0
    station_enabled = (
        station_center_x is not None
        and station_center_y is not None
        and station_radius_m is not None
        and float(station_radius_m) > 0.0
    )
    station_r2 = float(station_radius_m or 0.0) * float(station_radius_m or 0.0)
    station_bin_sec = max(1, int(station_bin_sec or 3600))
    station_pre_present: List[int] = []
    station_post_present: List[int] = []
    station_pre_visitors: set[str] = set()
    station_post_visitors: set[str] = set()
    station_pre_max_time = 0
    station_post_max_time = 0

    most_impacted: Optional[Dict[str, Any]] = None
    story_target: Optional[Dict[str, Any]] = None
    most_delta = float("-inf")
    best_story_rank: tuple[int, float] = (0, float("-inf"))

    for p in persons:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("personId") or "")
        plans = p.get("plans") or []
        if not isinstance(plans, list) or not plans:
            continue
        plans = [pl for pl in plans if isinstance(pl, dict)]
        if not plans:
            continue

        before_idx, after_idx, before_score, after_score = _compare_person_frequency_change(
            p,
            plans,
            route_id=route_id,
            new_frequency=new_f,
            waiting_pt_coeff_util_hr=waiting_pt_coeff_util_hr,
        )
        delta = after_score - before_score  # positive means improved utility
        before_plan = plans[before_idx] if 0 <= before_idx < len(plans) else plans[0]
        post_plan = plans[after_idx] if 0 <= after_idx < len(plans) else plans[0]
        person_payload = _person_compare_payload(
            person_id=pid,
            before_idx=before_idx,
            after_idx=after_idx,
            before_score=before_score,
            after_score=after_score,
            before_plan=before_plan,
            after_plan=post_plan,
            route_id=route_id,
            include_steps=include_most_impacted_steps,
        )
        if delta > most_delta:
            most_delta = delta
            most_impacted = person_payload

        story_rank = _story_candidate_rank(person_payload)
        if story_rank[0] > 0 and story_rank > best_story_rank:
            best_story_rank = story_rank
            story_target = person_payload

        if after_idx != before_idx:
            changed += 1
            if len(changed_sample) < max(0, int(changed_sample_n)):
                changed_sample.append({"personId": pid, "before": int(before_idx), "after": int(after_idx)})

        pre_agg.add_person_plan(pid, before_plan)
        post_agg.add_person_plan(pid, post_plan)
        if station_enabled:
            station_pre_max_time = max(
                station_pre_max_time,
                _accumulate_station_area_for_plan(
                    pid,
                    before_plan,
                    center_x=float(station_center_x),
                    center_y=float(station_center_y),
                    radius_sq=station_r2,
                    bin_sec=station_bin_sec,
                    present_by_bin=station_pre_present,
                    unique_visitors=station_pre_visitors,
                ),
            )
            station_post_max_time = max(
                station_post_max_time,
                _accumulate_station_area_for_plan(
                    pid,
                    post_plan,
                    center_x=float(station_center_x),
                    center_y=float(station_center_y),
                    radius_sq=station_r2,
                    bin_sec=station_bin_sec,
                    present_by_bin=station_post_present,
                    unique_visitors=station_post_visitors,
                ),
            )
        pre_total_utility += before_score
        post_total_utility += after_score
        utility_people += 1

    pre_out = pre_agg.to_dict(top_routes=top_routes)
    post_out = post_agg.to_dict(top_routes=top_routes)
    if utility_people > 0:
        pre_out["totalUtility"] = pre_total_utility
        pre_out["avgUtility"] = pre_total_utility / utility_people
        post_out["totalUtility"] = post_total_utility
        post_out["avgUtility"] = post_total_utility / utility_people

    station_area = None
    if station_enabled:
        station_area = {
            "stationName": station_name or "",
            "centerX": float(station_center_x),
            "centerY": float(station_center_y),
            "radiusM": float(station_radius_m),
            "binSec": station_bin_sec,
            "pre": {
                "uniqueVisitors": len(station_pre_visitors),
                "presentByBin": station_pre_present,
                "maxTimeSec": station_pre_max_time,
            },
            "post": {
                "uniqueVisitors": len(station_post_visitors),
                "presentByBin": station_post_present,
                "maxTimeSec": station_post_max_time,
            },
        }

    return {
        "routeId": route_id,
        "oldFrequency": old_f,
        "newFrequency": new_f,
        "deltaWaitMin": delta_wait_min,
        "deltaScore": delta_score,
        "changedPeople": changed,
        "changedSample": changed_sample,
        "mostImpacted": most_impacted,
        "storyTarget": story_target,
        "preAggregates": pre_out,
        "postAggregates": post_out,
        "stationArea": station_area,
    }
