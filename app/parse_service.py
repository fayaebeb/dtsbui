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
from .parsing import parse_plans_to_json
from .aggregates import compute_aggregates


class ParseError(Exception):
    """Raised when parsing cannot proceed."""


_PLAN_CANDIDATES = ("output_plans.xml.gz", "output_plans.xml")
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
    persons = parse_plans_to_json(
        plans_path,
        facilities_path,
        max_persons=limit,
        selected_only_flag=selected_only,
    )
    parsed_dir = os.path.join(current_app.config["STORAGE_ROOT"], "parsed")
    os.makedirs(parsed_dir, exist_ok=True)
    out_path = os.path.join(parsed_dir, f"{sim_id}.json.gz")
    with gzip.open(out_path, "wt", encoding="utf-8") as handle:
        json.dump(persons, handle)

    # Precompute aggregates for charts so the browser doesn't need all persons.
    agg_path = os.path.join(parsed_dir, f"{sim_id}.aggregates.json")
    try:
        agg = compute_aggregates(persons, top_routes=12)
        with open(agg_path, "w", encoding="utf-8") as ah:
            json.dump(agg, ah)
    except Exception:
        current_app.logger.exception("[parse] failed to compute aggregates for %s", sim_id)
        agg_path = None

    updated = update_simulation(
        sim_id,
        cached_json_path=out_path,
        cached_agg_path=agg_path,
        parsed_person_count=len(persons),
    )
    return {
        "ok": True,
        "count": len(persons),
        "cache": out_path,
        "simulation": updated,
    }


def run_parse(sim_id: str, limit: int, selected_only: bool = False) -> Dict[str, Any]:
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
        result = _parse_and_cache(sim_id, plans_path, facilities_path, limit, selected_only)
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

            plans_path = _extract_member(zf, plan_member, tmpd)
            facilities_path = _extract_member(zf, fac_member, tmpd) if fac_member else None

            logger.info("[parse] found plans=%s facilities=%s", plan_member, fac_member or "none")
            result = _parse_and_cache(sim_id, plans_path, facilities_path, limit, selected_only)
            logger.info("[parse] cached %s persons from blob", result["count"])
            return result
