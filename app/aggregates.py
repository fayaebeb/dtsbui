from __future__ import annotations

from typing import Any, Dict, List, Optional


def _pick_selected_plan(person: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    plans = person.get("plans") or []
    if not isinstance(plans, list) or not plans:
        return None
    idx = person.get("selectedPlanIndex")
    if not isinstance(idx, int) or idx < 0 or idx >= len(plans):
        idx = 0
    plan = plans[idx] or plans[0]
    return plan if isinstance(plan, dict) else None


class Aggregator:
    def __init__(self) -> None:
        self.total_people = 0
        self.total_travel_sec = 0.0
        self.total_utility = 0.0
        self.pt_users = 0
        self._pt_routes: Dict[str, Dict[str, Any]] = {}
        self._act_stats: Dict[str, Dict[str, Any]] = {}
        self._mode_stats: Dict[str, Dict[str, Any]] = {}

    def add_person_plan(self, person_id: str, plan: Dict[str, Any]) -> None:
        self.total_people += 1
        self.total_utility += float(plan.get("serverScore") or 0.0)

        person_travel = 0.0
        used_pt = False

        seen_acts = set()
        seen_modes = set()
        seen_pt_routes = set()

        for s in (plan.get("steps") or []):
            if not isinstance(s, dict):
                continue
            kind = s.get("kind")
            if kind == "leg":
                d = float(s.get("durationSec") or 0.0)
                person_travel += d

                mode = s.get("mode") or "__other__"
                seen_modes.add(mode)
                rec = self._mode_stats.setdefault(mode, {"people": 0, "timeSec": 0.0})
                rec["timeSec"] += d

                if mode == "pt":
                    used_pt = True
                    rid = s.get("transitRouteId") or s.get("transitLineId") or s.get("ptStartLink")
                    if rid:
                        seen_pt_routes.add(str(rid))
                        rrec = self._pt_routes.setdefault(str(rid), {"users": 0, "trips": 0})
                        rrec["trips"] += 1
            elif kind == "activity":
                d = float(s.get("durationSec") or 0.0)
                t = str(s.get("type") or "__other__")
                seen_acts.add(t)
                rec = self._act_stats.setdefault(t, {"people": 0, "timeSec": 0.0})
                rec["timeSec"] += d

        self.total_travel_sec += person_travel
        if used_pt:
            self.pt_users += 1

        for t in seen_acts:
            self._act_stats.setdefault(t, {"people": 0, "timeSec": 0.0})["people"] += 1
        for m in seen_modes:
            self._mode_stats.setdefault(m, {"people": 0, "timeSec": 0.0})["people"] += 1
        for rid in seen_pt_routes:
            self._pt_routes.setdefault(rid, {"users": 0, "trips": 0})["users"] += 1

    def to_dict(self, *, top_routes: int = 12) -> Dict[str, Any]:
        total_people = float(self.total_people or 0)
        avg_travel = (self.total_travel_sec / total_people) if total_people else 0.0
        avg_util = (self.total_utility / total_people) if total_people else 0.0

        route_rows = [
            {"rid": rid, "users": int(rec.get("users") or 0), "trips": int(rec.get("trips") or 0)}
            for rid, rec in self._pt_routes.items()
        ]
        route_rows.sort(key=lambda r: (r["users"], r["trips"]), reverse=True)

        return {
            "totalPeople": self.total_people,
            "totalTravelSec": self.total_travel_sec,
            "avgTravelSec": avg_travel,
            "totalUtility": self.total_utility,
            "avgUtility": avg_util,
            "ptUsers": self.pt_users,
            "actStats": self._act_stats,
            "modeStats": self._mode_stats,
            "ptRoutesTop": route_rows[: max(0, int(top_routes))],
        }


def compute_aggregates(persons: List[Dict[str, Any]], *, top_routes: int = 12) -> Dict[str, Any]:
    """
    Compute aggregate stats over the selected plan of each person.

    This mirrors the logic in `assets/js/aggregates.js`, but returns compact counts
    rather than per-route/per-type Sets so the payload stays small.
    """
    agg = Aggregator()
    for p in persons:
        if not isinstance(p, dict):
            continue
        plan = _pick_selected_plan(p)
        if not plan:
            continue
        person_id = str(p.get("personId") or "")
        agg.add_person_plan(person_id, plan)
    return agg.to_dict(top_routes=top_routes)
