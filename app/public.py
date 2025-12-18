import json
import os
import gzip
import datetime
from itertools import islice
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, render_template, jsonify, request, send_file, send_from_directory, current_app
from azure.storage.blob import generate_blob_sas, BlobSasPermissions

from .models import list_simulations, get_simulation
from .azure_utils import get_storage_context
from .frequency_compare import compute_frequency_compare_aggregates
from .station_counts import StationQuery
from .station_jobs import enqueue_station_job, get_station_status
from .person_cache import iter_cached_persons, read_cached_persons_sample
from .aggregates import Aggregator


public_bp = Blueprint("public", __name__)


# ---- Shared scoring logic (mirror of app.js) ----
_DEFAULT_WEIGHTS = {
    "act": {"Home": 1.0, "Work": 0.5, "Business": 0.3, "Shopping": 0.2, "__other__": 0.1},
    "leg": {"car": -2.0, "walk": 0.5, "pt": 0.1, "__other__": 0.0},
}


def _normalize_weights(payload: Dict[str, Any]) -> Dict[str, Dict[str, float]]:
    """Merge client-provided weights with defaults, keeping structure act/leg."""
    weights: Dict[str, Dict[str, float]] = {"act": {}, "leg": {}}
    src_act = (payload.get("act") or {}) if isinstance(payload, dict) else {}
    src_leg = (payload.get("leg") or {}) if isinstance(payload, dict) else {}

    for key, default_val in _DEFAULT_WEIGHTS["act"].items():
        try:
            weights["act"][key] = float(src_act.get(key, default_val))
        except (TypeError, ValueError):
            weights["act"][key] = default_val

    for key, default_val in _DEFAULT_WEIGHTS["leg"].items():
        try:
            weights["leg"][key] = float(src_leg.get(key, default_val))
        except (TypeError, ValueError):
            weights["leg"][key] = default_val

    return weights


def _compute_score_client(plan: Dict[str, Any], weights: Dict[str, Dict[str, float]]) -> float:
    """Client-side score: mirror of computeScoreClient in app.js."""
    steps = plan.get("steps") or []
    if not isinstance(steps, list):
        return 0.0
    score = 0.0
    for s in steps:
        if not isinstance(s, dict):
            continue
        kind = s.get("kind")
        if kind == "activity":
            w = weights["act"].get(s.get("type")) or weights["act"].get("__other__", 0.0)
            score += float(s.get("durationSec") or 0.0) * float(w)
        elif kind == "leg":
            w = weights["leg"].get(s.get("mode")) or weights["leg"].get("__other__", 0.0)
            score += float(s.get("durationSec") or 0.0) * float(w)
    return score


def _compute_summary_iter(persons, weights: Dict[str, Dict[str, float]]) -> Dict[str, Any]:
    """Compute aggregate stats and top plans over all persons."""
    person_count = 0

    total_client_score = 0.0
    selected_plan_count = 0

    best_plan: Optional[Dict[str, Any]] = None
    best_bus_plan: Optional[Dict[str, Any]] = None

    for p in persons:
        if not isinstance(p, dict):
            continue
        person_count += 1
        plans = p.get("plans") or []
        if not isinstance(plans, list) or not plans:
            continue

        # Selected plan for this person
        sel_idx = p.get("selectedPlanIndex")
        if not isinstance(sel_idx, int) or sel_idx < 0 or sel_idx >= len(plans):
            sel_idx = 0
        sel_plan = plans[sel_idx] or plans[0]

        sel_client = _compute_score_client(sel_plan, weights)
        total_client_score += sel_client
        selected_plan_count += 1

        # Scan all plans for global best and best bus plan
        person_id = p.get("personId")
        for idx, pl in enumerate(plans):
            if not isinstance(pl, dict):
                continue
            client_score = _compute_score_client(pl, weights)
            if best_plan is None or client_score > best_plan.get("clientScore", float("-inf")):
                best_plan = {
                    "personId": person_id,
                    "planIndex": idx,
                    "clientScore": client_score,
                    "matsimScore": pl.get("matsimScore"),
                    "serverScore": pl.get("serverScore"),
                    "steps": pl.get("steps"),
                }

            steps = pl.get("steps") or []
            has_bus = any(
                isinstance(s, dict)
                and s.get("kind") == "leg"
                and s.get("mode") in ("pt", "bus")
                for s in steps
            )
            if has_bus:
                if best_bus_plan is None or client_score > best_bus_plan.get("clientScore", float("-inf")):
                    best_bus_plan = {
                        "personId": person_id,
                        "planIndex": idx,
                        "clientScore": client_score,
                        "matsimScore": pl.get("matsimScore"),
                        "serverScore": pl.get("serverScore"),
                        "steps": pl.get("steps"),
                    }

    avg_client_score = None
    if selected_plan_count > 0:
        avg_client_score = total_client_score / selected_plan_count

    return {
        "personCount": person_count,
        "selectedPlanCount": selected_plan_count,
        "avgClientScore": avg_client_score,
        "bestPlan": best_plan,
        "bestBusPlan": best_bus_plan,
    }


@public_bp.route("/")
def home():
    # Serve the existing rich viewer at project root
    root_index = os.path.join(os.getcwd(), "index.html")
    if os.path.isfile(root_index):
        return send_file(root_index)
    return render_template("index.html")


@public_bp.route("/assets/<path:filename>")
def assets(filename):
    assets_root = os.path.join(os.getcwd(), "assets")
    return send_from_directory(assets_root, filename)


@public_bp.route("/api/simulations", methods=["GET"])
def public_list():
    rows = list_simulations(all_rows=False)
    return jsonify([
        {
            "id": r["id"],
            "name": r["name"],
            "uploaded_at": r["uploaded_at"],
            "size": r.get("size"),
            "has_blob": bool(r.get("blob_name")),
            "has_cache": bool(r.get("cached_json_path")),
            "has_aggregates": bool(r.get("cached_agg_path")),
        }
        for r in rows
    ])


@public_bp.route("/api/simulations/<sim_id>/data", methods=["GET"])
def public_data(sim_id):
    sim = get_simulation(sim_id)
    if not sim or not sim.get("published"):
        return jsonify({"error": "Not found"}), 404

    # Prefer cached json if exists
    cache = sim.get("cached_json_path")
    if cache:
        cache_path = cache
        if not os.path.isabs(cache_path):
            cache_path = os.path.abspath(cache_path)
        if os.path.isfile(cache_path):
            # Down-sample persons before returning to the browser
            # to avoid loading hundreds of thousands of persons into JS.
            try:
                limit = int((request.args.get("limit") or os.getenv("PUBLIC_MAX_PERSONS", "1000")))
            except Exception:
                limit = 1000
            limit = max(1, limit)

            persons = read_cached_persons_sample(cache_path, limit)

            # For map/UI, always ship only the selected plan per person to keep payload small.
            slim: List[Dict[str, Any]] = []
            for p in persons:
                plans = p.get("plans") or []
                if not isinstance(plans, list) or not plans:
                    continue
                idx = p.get("selectedPlanIndex")
                if not isinstance(idx, int) or idx < 0 or idx >= len(plans):
                    idx = 0
                plan = plans[idx] if 0 <= idx < len(plans) else plans[0]
                if not isinstance(plan, dict):
                    continue
                slim.append({"personId": p.get("personId"), "selectedPlanIndex": 0, "plans": [plan]})

            return jsonify(slim)

    return jsonify({"error": "No cached data. Admin must parse this simulation first."}), 400


@public_bp.route("/api/simulations/<sim_id>/summary", methods=["POST"])
def public_summary(sim_id):
    """Return aggregate stats and top plans computed over all persons."""
    sim = get_simulation(sim_id)
    if not sim or not sim.get("published"):
        return jsonify({"error": "Not found"}), 404

    cache = sim.get("cached_json_path")
    if not cache:
        return jsonify({"error": "No cached data. Admin must parse this simulation first."}), 400

    cache_path = cache
    if not os.path.isabs(cache_path):
        cache_path = os.path.abspath(cache_path)
    if not os.path.isfile(cache_path):
        current_app.logger.warning("Cached JSON path missing for summary: %s", cache_path)
        return jsonify({"error": "Cached data file missing"}), 500

    payload = request.get_json(silent=True) or {}
    weights_payload = payload.get("weights") or {}
    weights = _normalize_weights(weights_payload if isinstance(weights_payload, dict) else {})

    persons_iter = iter_cached_persons(cache_path)
    summary = _compute_summary_iter(persons_iter, weights)
    return jsonify(summary)


def _resolve_cache_path(path: str) -> str:
    return path if os.path.isabs(path) else os.path.abspath(path)

def _coerce_person_limit(v: Any) -> Optional[int]:
    if v is None:
        return None
    if isinstance(v, str) and v.strip().lower() in {"", "all", "none", "null"}:
        return None
    try:
        n = int(v)
    except Exception:
        return None
    return n if n > 0 else None


def _compute_selected_aggregates_from_cache(
    cache_path: str,
    *,
    top_routes_n: int,
    person_limit: Optional[int] = None,
) -> Dict[str, Any]:
    agg_calc = Aggregator()
    persons_iter = iter_cached_persons(cache_path)
    if person_limit is not None:
        persons_iter = islice(persons_iter, person_limit)

    for p in persons_iter:
        if not isinstance(p, dict):
            continue
        plans = p.get("plans") or []
        if not isinstance(plans, list) or not plans:
            continue
        idx = p.get("selectedPlanIndex")
        if not isinstance(idx, int) or idx < 0 or idx >= len(plans):
            idx = 0
        plan = plans[idx] if 0 <= idx < len(plans) else plans[0]
        if not isinstance(plan, dict):
            continue
        agg_calc.add_person_plan(str(p.get("personId") or ""), plan)

    return agg_calc.to_dict(top_routes=top_routes_n)


def _get_aggregates_for_sim(
    sim_id: str,
    *,
    top_routes_n: int,
    person_limit: Optional[int] = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[Tuple[Dict[str, Any], int]]]:
    sim = get_simulation(sim_id)
    if not sim or not sim.get("published"):
        return None, ({"error": "Not found"}, 404)

    person_limit = _coerce_person_limit(person_limit)

    # Prefer precomputed aggregates from parse time
    if person_limit is None:
        agg_path = sim.get("cached_agg_path")
        if isinstance(agg_path, str) and agg_path:
            agg_file = _resolve_cache_path(agg_path)
            if os.path.isfile(agg_file):
                with open(agg_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("ptRoutesTop"), list):
                    data["ptRoutesTop"] = data["ptRoutesTop"][:top_routes_n]
                return data if isinstance(data, dict) else {}, None

    cache = sim.get("cached_json_path")
    if not cache:
        return None, ({"error": "No cached data. Admin must parse this simulation first."}, 400)
    cache_path = _resolve_cache_path(cache)
    if not os.path.isfile(cache_path):
        return None, ({"error": "Cached data file missing"}, 500)

    agg = _compute_selected_aggregates_from_cache(cache_path, top_routes_n=top_routes_n, person_limit=person_limit)

    # Only persist aggregates when it's a full-dataset compute.
    if person_limit is None:
        try:
            parsed_dir = os.path.dirname(cache_path)
            out_path = os.path.join(parsed_dir, f"{sim_id}.aggregates.json")
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(agg, f)
            from .models import update_simulation

            update_simulation(sim_id, cached_agg_path=out_path)
        except Exception:
            current_app.logger.exception("Failed to persist aggregates for %s", sim_id)

    return agg, None


@public_bp.route("/api/simulations/<sim_id>/aggregates", methods=["GET"])
def public_aggregates(sim_id: str):
    """Return aggregate stats for charts computed over all persons (selected plan)."""
    top_routes = request.args.get("top_routes", "12")
    try:
        top_routes_n = max(0, int(top_routes))
    except Exception:
        top_routes_n = 12

    person_limit = _coerce_person_limit(request.args.get("person_limit"))
    data, err = _get_aggregates_for_sim(sim_id, top_routes_n=top_routes_n, person_limit=person_limit)
    if err:
        body, code = err
        return jsonify(body), code
    return jsonify(data)


@public_bp.route("/api/simulations/compare-aggregates", methods=["POST"])
def public_compare_aggregates():
    payload = request.get_json(silent=True) or {}
    pre_id = (payload.get("pre_id") or "").strip()
    post_id = (payload.get("post_id") or "").strip()
    if not pre_id or not post_id:
        return jsonify({"error": "pre_id and post_id required"}), 400

    top_routes = payload.get("top_routes", 12)
    try:
        top_routes_n = max(0, int(top_routes))
    except Exception:
        top_routes_n = 12

    person_limit = _coerce_person_limit(payload.get("person_limit") or payload.get("personLimit") or payload.get("limit"))

    pre, pre_err = _get_aggregates_for_sim(pre_id, top_routes_n=top_routes_n, person_limit=person_limit)
    if pre_err:
        body, code = pre_err
        return jsonify(body), code
    post, post_err = _get_aggregates_for_sim(post_id, top_routes_n=top_routes_n, person_limit=person_limit)
    if post_err:
        body, code = post_err
        return jsonify(body), code

    return jsonify({"pre_id": pre_id, "post_id": post_id, "personLimit": person_limit, "pre": pre, "post": post})


@public_bp.route("/api/simulations/<sim_id>/frequency-compare", methods=["POST"])
def public_frequency_compare(sim_id: str):
    """
    Compare aggregates before/after changing 運航頻度 (frequency) for a specific route.
    Uses the full cached dataset (all persons) but returns only compact aggregates.
    """
    sim = get_simulation(sim_id)
    if not sim or not sim.get("published"):
        return jsonify({"error": "Not found"}), 404

    cache = sim.get("cached_json_path")
    if not cache:
        return jsonify({"error": "No cached data. Admin must parse this simulation first."}), 400
    cache_path = _resolve_cache_path(cache)
    if not os.path.isfile(cache_path):
        return jsonify({"error": "Cached data file missing"}), 500

    payload = request.get_json(silent=True) or {}
    route_id = str(payload.get("routeId") or "")
    old_f = payload.get("oldFrequency")
    new_f = payload.get("newFrequency")
    if old_f is None or new_f is None:
        return jsonify({"error": "oldFrequency and newFrequency required"}), 400
    include_most_steps = str(payload.get("includeMostImpactedSteps") or "").lower() in {"1", "true", "yes"}
    person_limit = _coerce_person_limit(payload.get("person_limit") or payload.get("personLimit") or payload.get("limit"))

    # Prefer an explicit walk coefficient; else derive from weights (if provided).
    walk_coeff = payload.get("walkCoeffPerSec")
    if walk_coeff is None:
        weights_payload = payload.get("weights") or {}
        if isinstance(weights_payload, dict):
            leg = weights_payload.get("leg") or {}
            if isinstance(leg, dict):
                walk_coeff = leg.get("walk")
    try:
        walk_coeff_per_sec = float(walk_coeff) if walk_coeff is not None else 0.5
    except Exception:
        walk_coeff_per_sec = 0.5

    # Baseline aggregates can come from the precomputed cache (fast).
    if person_limit is None:
        pre, pre_err = _get_aggregates_for_sim(sim_id, top_routes_n=12)
        if pre_err:
            body, code = pre_err
            return jsonify(body), code
    else:
        pre = _compute_selected_aggregates_from_cache(cache_path, top_routes_n=12, person_limit=person_limit)

    # Frequency compare requires multiple plans per person to allow plan switching.
    # If the simulation was parsed in selected-only mode, this will always show no change.
    peek = read_cached_persons_sample(cache_path, 3)
    if peek and all(isinstance(p.get("plans") or [], list) and len(p.get("plans") or []) <= 1 for p in peek):
        return jsonify({"error": "This simulation was parsed with selected-only plans. Re-parse with 'Parse all plans' to enable frequency compare."}), 400

    cmp = compute_frequency_compare_aggregates(
        islice(iter_cached_persons(cache_path), person_limit) if person_limit is not None else iter_cached_persons(cache_path),
        route_id=route_id,
        old_frequency=float(old_f),
        new_frequency=float(new_f),
        top_routes=12,
        walk_coeff_per_sec=walk_coeff_per_sec,
        changed_sample_n=50,
        include_most_impacted_steps=include_most_steps,
    )

    return jsonify({
        "sim_id": sim_id,
        "params": {
            "routeId": route_id,
            "oldFrequency": float(old_f),
            "newFrequency": float(new_f),
            "walkCoeffPerSec": walk_coeff_per_sec,
            "personLimit": person_limit,
        },
        "changedPeople": int(cmp.get("changedPeople") or 0),
        "changedSample": cmp.get("changedSample") or [],
        "mostImpacted": cmp.get("mostImpacted"),
        "pre": pre,
        "post": cmp.get("postAggregates") or {},
    })

@public_bp.route("/api/simulations/<sim_id>/blob-url", methods=["GET"])
def public_blob_url(sim_id):
    sim = get_simulation(sim_id)
    if not sim or not sim.get("published"):
        return jsonify({"error": "Not found"}), 404
    blob_name = sim.get("blob_name")
    if not blob_name:
        return jsonify({"error": "No remote blob"}), 404

    try:
        bsc, account, container, account_key = get_storage_context(require_account_key=True)
    except RuntimeError as exc:
        current_app.logger.error("Blob SAS configuration error: %s", exc)
        return jsonify({"error": "Blob access not configured"}), 500

    expiry = datetime.datetime.utcnow() + datetime.timedelta(hours=1)
    sas = generate_blob_sas(
        account_name=account,
        container_name=container,
        blob_name=blob_name,
        account_key=account_key,
        permission=BlobSasPermissions(read=True),
        expiry=expiry,
    )
    blob_url = f"https://{account}.blob.core.windows.net/{container}/{blob_name}"
    return jsonify({
        "downloadUrl": f"{blob_url}?{sas}",
        "expiresAt": expiry.isoformat() + "Z",
    })


@public_bp.route("/api/simulations/<sim_id>/station-counts", methods=["POST"])
def public_station_counts(sim_id: str):
    sim = get_simulation(sim_id)
    if not sim or not sim.get("published"):
        return jsonify({"error": "Not found"}), 404

    payload = request.get_json(silent=True) or {}
    try:
        center_x = float(payload.get("centerX"))
        center_y = float(payload.get("centerY"))
        radius_m = float(payload.get("radiusM") or 500.0)
        bin_sec = int(payload.get("binSec") or 3600)
    except Exception:
        return jsonify({"error": "Invalid payload"}), 400

    if radius_m <= 0:
        return jsonify({"error": "radiusM must be > 0"}), 400
    if bin_sec <= 0 or bin_sec > 24 * 3600:
        return jsonify({"error": "binSec out of range"}), 400

    try:
        q = StationQuery(center_x=center_x, center_y=center_y, radius_m=radius_m, bin_sec=bin_sec)
        out = enqueue_station_job(sim_id, q)
        status = str(out.get("status") or "")
        code = 200 if status == "succeeded" else (500 if status == "failed" else 202)
        return jsonify(out), code
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        current_app.logger.exception("[station] failed for %s", sim_id)
        return jsonify({"error": str(exc) or "station-counts failed"}), 500


@public_bp.route("/api/simulations/<sim_id>/station-counts/status", methods=["POST"])
def public_station_counts_status(sim_id: str):
    sim = get_simulation(sim_id)
    if not sim or not sim.get("published"):
        return jsonify({"error": "Not found"}), 404

    payload = request.get_json(silent=True) or {}
    try:
        center_x = float(payload.get("centerX"))
        center_y = float(payload.get("centerY"))
        radius_m = float(payload.get("radiusM") or 500.0)
        bin_sec = int(payload.get("binSec") or 3600)
    except Exception:
        return jsonify({"error": "Invalid payload"}), 400

    if radius_m <= 0:
        return jsonify({"error": "radiusM must be > 0"}), 400
    if bin_sec <= 0 or bin_sec > 24 * 3600:
        return jsonify({"error": "binSec out of range"}), 400

    try:
        q = StationQuery(center_x=center_x, center_y=center_y, radius_m=radius_m, bin_sec=bin_sec)
        out = get_station_status(sim_id, q)
        status = str(out.get("status") or "")
        code = 200 if status == "succeeded" else (500 if status == "failed" else 202)
        return jsonify(out), code
    except Exception as exc:
        current_app.logger.exception("[station] status failed for %s", sim_id)
        return jsonify({"error": str(exc) or "station-counts status failed"}), 500
