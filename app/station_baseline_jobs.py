import os
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime
from typing import Any, Dict, Optional, cast

from flask import Flask, current_app

from .models import get_simulation, update_simulation
from .station_frequency_cache import build_station_baselines_from_cache, station_baseline_path


_MAX_WORKERS = int(os.getenv("STATION_BASELINE_WORKERS", "1") or "1")
_EXECUTOR: ThreadPoolExecutor = ThreadPoolExecutor(max_workers=max(1, _MAX_WORKERS))
_ACTIVE_JOBS: Dict[str, Dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _job_payload(sim: Dict[str, Any], status: Optional[str] = None) -> Dict[str, Any]:
    baseline_path = station_baseline_path(str(sim.get("id") or ""))
    effective = status or sim.get("station_baseline_status") or ("succeeded" if os.path.isfile(baseline_path) else "idle")
    return {
        "status": effective,
        "path": baseline_path if os.path.isfile(baseline_path) else None,
        "error": sim.get("station_baseline_error"),
        "started_at": sim.get("station_baseline_started_at"),
        "completed_at": sim.get("station_baseline_completed_at"),
        "simulation": sim,
    }


def get_station_baseline_status(sim_id: str) -> Optional[Dict[str, Any]]:
    sim = get_simulation(sim_id)
    if not sim:
        return None
    status = sim.get("station_baseline_status")
    with _JOBS_LOCK:
        job = _ACTIVE_JOBS.get(sim_id)
        if job and not job["future"].done():
            status = job.get("status", status)
    return _job_payload(sim, status)


def enqueue_station_baseline_job(sim_id: str, *, force: bool = False) -> Dict[str, Any]:
    sim = get_simulation(sim_id)
    if not sim:
        raise LookupError("simulation not found")
    if not sim.get("cached_json_path"):
        raise FileNotFoundError("simulation must be parsed before building station baselines")

    if (sim.get("parse_status") or "").lower() in {"queued", "running"}:
        raise RuntimeError("cannot build station baseline while parse is running")

    status = sim.get("station_baseline_status") or ("succeeded" if os.path.isfile(station_baseline_path(sim_id)) else "idle")
    if status in {"running", "queued"}:
        with _JOBS_LOCK:
            job = _ACTIVE_JOBS.get(sim_id)
            if job and not job["future"].done():
                status = job.get("status", status)
        return _job_payload(sim, status)

    if status == "succeeded" and os.path.isfile(station_baseline_path(sim_id)) and not force:
        refreshed = get_simulation(sim_id)
        if not refreshed:
            raise LookupError("simulation not found after refresh")
        return _job_payload(refreshed, "succeeded")

    with _JOBS_LOCK:
        job = _ACTIVE_JOBS.get(sim_id)
        if job and not job["future"].done():
            return _job_payload(sim, job.get("status"))

        app: Flask = cast(Flask, current_app._get_current_object())  # type: ignore[attr-defined]
        queued_row = update_simulation(
            sim_id,
            station_baseline_status="queued",
            station_baseline_error=None,
            station_baseline_started_at=None,
            station_baseline_completed_at=None,
        )
        if queued_row is None:
            raise LookupError("failed to update simulation")

        future: Future = _EXECUTOR.submit(_run_job, app, sim_id)
        _ACTIVE_JOBS[sim_id] = {"future": future, "status": "queued"}

    return _job_payload(queued_row, "queued")


def _run_job(app: Flask, sim_id: str) -> None:
    with app.app_context():
        current_app.logger.info("[station-baseline] job started for %s", sim_id)
        update_simulation(
            sim_id,
            station_baseline_status="running",
            station_baseline_started_at=_now_iso(),
            station_baseline_error=None,
        )
        with _JOBS_LOCK:
            if sim_id in _ACTIVE_JOBS:
                _ACTIVE_JOBS[sim_id]["status"] = "running"

        try:
            result = build_station_baselines_from_cache(sim_id)
            update_simulation(
                sim_id,
                station_baseline_status="succeeded",
                station_baseline_completed_at=_now_iso(),
                station_baseline_error=None,
            )
            current_app.logger.info(
                "[station-baseline] job finished for %s (stations=%s profiles=%s)",
                sim_id,
                result.get("stations"),
                result.get("profiles"),
            )
        except Exception as exc:
            update_simulation(
                sim_id,
                station_baseline_status="failed",
                station_baseline_completed_at=_now_iso(),
                station_baseline_error=str(exc),
            )
            current_app.logger.exception("[station-baseline] job failed for %s", sim_id)
        finally:
            with _JOBS_LOCK:
                _ACTIVE_JOBS.pop(sim_id, None)
