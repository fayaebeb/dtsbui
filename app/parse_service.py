import gzip
import json
import os
import shutil
import tempfile
import zipfile
from typing import Any, Dict, Optional, Tuple

from flask import current_app
from azure.storage.blob import BlobClient

from .azure_utils import get_storage_context
from .models import get_simulation, update_simulation
from .parsing import iter_plans_to_persons
from .aggregates import Aggregator
from .person_cache import write_ndjson_gz


class ParseError(Exception):
    """Raised when parsing cannot proceed."""


_PLAN_CANDIDATES = ("output_plans.xml.gz", "output_plans.xml")
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


def _parse_and_cache(sim_id: str, plans_path: str, facilities_path: Optional[str], limit: int, selected_only: bool) -> Dict[str, Any]:
    people_iter = iter_plans_to_persons(
        plans_path,
        facilities_path,
        max_persons=limit,
        selected_only_flag=selected_only,
    )
    parsed_dir = os.path.join(current_app.config["STORAGE_ROOT"], "parsed")
    os.makedirs(parsed_dir, exist_ok=True)
    out_path = os.path.join(parsed_dir, f"{sim_id}.ndjson.gz")

    # Stream persons to disk and compute aggregates on the fly to avoid OOM.
    agg = Aggregator()
    sample: list[dict[str, Any]] = []
    sample_limit = int(os.getenv("PUBLIC_MAX_PERSONS", "1000") or "1000")
    sample_limit = max(1, sample_limit)
    count = 0

    def _iter_and_accumulate():
        nonlocal count
        for p in people_iter:
            if isinstance(p, dict):
                plans = p.get("plans") or []
                if isinstance(plans, list) and plans:
                    pid = str(p.get("personId") or "")
                    sel_idx = p.get("selectedPlanIndex")
                    if not isinstance(sel_idx, int) or sel_idx < 0 or sel_idx >= len(plans):
                        sel_idx = 0
                    plan = plans[sel_idx] if 0 <= sel_idx < len(plans) else (plans[0] if plans else None)
                    if isinstance(plan, dict):
                        agg.add_person_plan(pid, plan)
                if len(sample) < sample_limit:
                    sample.append(p)
                count += 1
                yield p

    write_ndjson_gz(out_path, _iter_and_accumulate())

    # Precompute aggregates for charts so the browser doesn't need all persons.
    agg_path: Optional[str] = os.path.join(parsed_dir, f"{sim_id}.aggregates.json")
    try:
        with open(agg_path, "w", encoding="utf-8") as ah:
            json.dump(agg.to_dict(top_routes=12), ah)
    except Exception:
        current_app.logger.exception("[parse] failed to compute aggregates for %s", sim_id)
        agg_path = None

    updated = update_simulation(
        sim_id,
        cached_json_path=out_path,
        cached_agg_path=agg_path,
        parsed_person_count=count,
    )
    return {
        "ok": True,
        "count": count,
        "cache": out_path,
        "simulation": updated,
    }


def run_parse(sim_id: str, limit: int, selected_only: bool = True) -> Dict[str, Any]:
    """Parse the specified simulation and cache the result to disk."""
    sim = get_simulation(sim_id)
    if not sim:
        raise ParseError("Not found")

    folder = sim.get("path")
    logger = current_app.logger

    if folder and os.path.isdir(folder):
        logger.info("[parse] using local folder %s", folder)
        plans_path = _find_first_existing(folder, tuple(_PLAN_CANDIDATES))
        if not plans_path:
            raise ParseError("plans file not found in local folder")
        facilities_path = _find_first_existing(folder, tuple(_FACILITY_CANDIDATES))
        events_path = _find_first_existing(folder, tuple(_EVENT_CANDIDATES))
        result = _parse_and_cache(sim_id, plans_path, facilities_path, limit, selected_only)

        # If events are present, record their path so station-count queries can avoid zip access.
        if events_path:
            try:
                update_simulation(sim_id, cached_events_path=events_path)
            except Exception:
                current_app.logger.exception("[parse] failed to record cached_events_path for %s", sim_id)

        logger.info("[parse] cached %s persons from local folder", result["count"])
        return result

    blob_name = sim.get("blob_name")
    if not blob_name:
        raise ParseError("No path or blob available")

    bsc, account, container, _key = get_storage_context()
    blob: BlobClient = bsc.get_blob_client(container, blob_name)

    with tempfile.TemporaryDirectory(dir=current_app.config["STORAGE_ROOT"]) as tmpd:
        tmp_zip = os.path.join(tmpd, "sim.zip")
        logger.info("[parse] downloading blob %s to %s", blob_name, tmp_zip)
        with open(tmp_zip, "wb") as handle:
            blob.download_blob().readinto(handle)

        with zipfile.ZipFile(tmp_zip, "r") as zf:
            plan_member = _locate_member(zf, tuple(_PLAN_CANDIDATES))
            if not plan_member:
                raise ParseError("plans file not found in zip")
            fac_member = _locate_member(zf, tuple(_FACILITY_CANDIDATES))
            ev_member = _locate_member(zf, tuple(_EVENT_CANDIDATES))

            plans_path = _extract_member(zf, plan_member, tmpd)
            facilities_path = _extract_member(zf, fac_member, tmpd) if fac_member else None
            events_path = _extract_member(zf, ev_member, tmpd) if ev_member else None

            logger.info("[parse] found plans=%s facilities=%s events=%s", plan_member, fac_member or "none", ev_member or "none")
            result = _parse_and_cache(sim_id, plans_path, facilities_path, limit, selected_only)

            # Cache events locally so station-count queries don't have to re-download the zip.
            if events_path:
                parsed_dir = os.path.join(current_app.config["STORAGE_ROOT"], "parsed")
                os.makedirs(parsed_dir, exist_ok=True)
                cached_events_path = os.path.join(
                    parsed_dir,
                    f"{sim_id}.events{'.xml.gz' if events_path.endswith('.gz') else '.xml'}",
                )
                try:
                    shutil.copyfile(events_path, cached_events_path)
                    update_simulation(sim_id, cached_events_path=cached_events_path)
                except Exception:
                    current_app.logger.exception("[parse] failed to cache events for %s", sim_id)

            logger.info("[parse] cached %s persons from blob", result["count"])
            return result
