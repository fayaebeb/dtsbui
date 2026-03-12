from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from .aggregates import Aggregator

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


def _plan_affected_by_route(plan: Dict[str, Any], route_id: str) -> bool:
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


def compare_frequency(
    persons: Iterable[Dict[str, Any]],
    *,
    route_id: str,
    old_frequency: float,
    new_frequency: float,
    walk_coeff_per_sec: float = 0.5,
) -> Dict[str, Any]:
    """
    Apply the same frequency utility adjustment used in assets/js/route_sim.js and
    return before/after selected plan indices per person (plus changed count).
    """
    old_f = max(1.0, float(old_frequency or 0.0))
    new_f = max(1.0, float(new_frequency or 0.0))
    delta_wait_min = ((60.0 / old_f) - (60.0 / new_f)) / 2.0
    # Treat score as utility (higher is better): higher frequency -> lower wait -> higher utility.
    delta_score = (delta_wait_min * 60.0) * float(walk_coeff_per_sec)

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

        # Use the same objective for baseline and post-change selection.
        before_idx = _best_index_by_server_score(plans)

        plan_affected: List[bool] = []
        adjusted_scores: List[float] = []
        for pl in plans:
            base = float(pl.get("serverScore") or 0.0)
            affected = _plan_affected_by_route(pl, route_id)
            plan_affected.append(affected)
            adjusted_scores.append(base + delta_score if affected else base)

        # If no plan for this person is affected (or no effective frequency change),
        # keep the current selected plan unchanged.
        any_affected = any(plan_affected)
        if not any_affected or abs(delta_score) < 1e-12:
            after_idx = before_idx
            before_indices[pid] = before_idx
            after_indices[pid] = after_idx
            continue

        after_idx = _argmax(adjusted_scores)

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


def compute_frequency_compare_aggregates(
    persons: Iterable[Dict[str, Any]],
    *,
    route_id: str,
    old_frequency: float,
    new_frequency: float,
    top_routes: int = 12,
    walk_coeff_per_sec: float = 0.5,
    changed_sample_n: int = 50,
    include_most_impacted_steps: bool = False,
) -> Dict[str, Any]:
    """
    Compute post-change aggregates (over all persons) for a frequency adjustment,
    without materializing large per-person index maps.
    """
    old_f = max(1.0, float(old_frequency or 0.0))
    new_f = max(1.0, float(new_frequency or 0.0))
    delta_wait_min = ((60.0 / old_f) - (60.0 / new_f)) / 2.0
    # Treat score as utility (higher is better): higher frequency -> lower wait -> higher utility.
    delta_score = (delta_wait_min * 60.0) * float(walk_coeff_per_sec)

    changed = 0
    changed_sample: List[Dict[str, Any]] = []

    pre_agg = Aggregator()
    post_agg = Aggregator()
    pre_total_utility = 0.0
    post_total_utility = 0.0
    utility_people = 0

    most_impacted: Optional[Dict[str, Any]] = None
    most_delta = float("-inf")

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

        # Use the same objective for baseline and post-change selection.
        before_idx = _best_index_by_server_score(plans)

        plan_affected: List[bool] = []
        adjusted_scores: List[float] = []
        for pl in plans:
            base = float(pl.get("serverScore") or 0.0)
            affected = _plan_affected_by_route(pl, route_id)
            plan_affected.append(affected)
            adjusted_scores.append(base + delta_score if affected else base)

        any_affected = any(plan_affected)
        if not any_affected or abs(delta_score) < 1e-12:
            after_idx = before_idx
            best_val = (
                float(plans[before_idx].get("serverScore") or 0.0)
                if 0 <= before_idx < len(plans)
                else 0.0
            )
        else:
            after_idx = _argmax(adjusted_scores)
            best_val = adjusted_scores[after_idx] if 0 <= after_idx < len(adjusted_scores) else 0.0

        before_score = float(plans[before_idx].get("serverScore") or 0.0) if 0 <= before_idx < len(plans) else 0.0
        after_score = float(best_val or 0.0)
        delta = after_score - before_score  # positive means improved utility
        if delta > most_delta:
            most_delta = delta
            most_impacted = {
                "personId": pid,
                "beforePlanIndex": int(before_idx),
                "afterPlanIndex": int(after_idx),
                "beforeScore": before_score,
                "afterScore": after_score,
                "deltaScore": delta,
                "changedPlan": bool(after_idx != before_idx),
            }
            if include_most_impacted_steps:
                pre_plan = plans[before_idx] if 0 <= before_idx < len(plans) else plans[0]
                post_plan = plans[after_idx] if 0 <= after_idx < len(plans) else plans[0]
                most_impacted["beforePlanSteps"] = pre_plan.get("steps") or []
                most_impacted["afterPlanSteps"] = post_plan.get("steps") or []

        if after_idx != before_idx:
            changed += 1
            if len(changed_sample) < max(0, int(changed_sample_n)):
                changed_sample.append({"personId": pid, "before": int(before_idx), "after": int(after_idx)})

        before_plan = plans[before_idx] if 0 <= before_idx < len(plans) else plans[0]
        pre_agg.add_person_plan(pid, before_plan)
        post_plan = plans[after_idx] if 0 <= after_idx < len(plans) else plans[0]
        post_agg.add_person_plan(pid, post_plan)
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

    return {
        "routeId": route_id,
        "oldFrequency": old_f,
        "newFrequency": new_f,
        "deltaWaitMin": delta_wait_min,
        "deltaScore": delta_score,
        "changedPeople": changed,
        "changedSample": changed_sample,
        "mostImpacted": most_impacted,
        "preAggregates": pre_out,
        "postAggregates": post_out,
    }
