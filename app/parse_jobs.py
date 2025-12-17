import os
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime
from typing import Any, Dict, Optional, cast

from flask import current_app, Flask

from .models import get_simulation, update_simulation
from .parse_service import ParseError, run_parse


_MAX_WORKERS = int(os.getenv("PARSE_WORKERS", "1") or "1")
_EXECUTOR: ThreadPoolExecutor = ThreadPoolExecutor(max_workers=max(1, _MAX_WORKERS))
_ACTIVE_JOBS: Dict[str, Dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _job_payload(sim: Dict[str, Any], status: Optional[str] = None) -> Dict[str, Any]:
    """Builds a payload describing the current parse state of a simulation."""
    effective = status or sim.get("parse_status") or ("succeeded" if sim.get("cached_json_path") else "idle")
    return {
        "status": effective,
        "cache": sim.get("cached_json_path"),
        "count": sim.get("parsed_person_count"),
        "error": sim.get("parse_error"),
        "started_at": sim.get("parse_started_at"),
        "completed_at": sim.get("parse_completed_at"),
        "simulation": sim,
    }


def get_parse_status(sim_id: str) -> Optional[Dict[str, Any]]:
    sim = get_simulation(sim_id)
    if not sim:
        return None
    status = sim.get("parse_status")
    with _JOBS_LOCK:
        job = _ACTIVE_JOBS.get(sim_id)
        if job and not job["future"].done():
            status = job.get("status", status)
    return _job_payload(sim, status)


def enqueue_parse_job(sim_id: str, limit: int, *, force: bool = False, selected_only: bool = True) -> Dict[str, Any]:
    sim = get_simulation(sim_id)
    if not sim:
        raise LookupError("simulation not found")

    status = sim.get("parse_status") or ("succeeded" if sim.get("cached_json_path") else "idle")
    if status in {"running", "queued"}:
        with _JOBS_LOCK:
            job = _ACTIVE_JOBS.get(sim_id)
            if job and not job["future"].done():
                status = job.get("status", status)
        return _job_payload(sim, status)

    if status == "succeeded" and sim.get("cached_json_path") and not force:
        refreshed = get_simulation(sim_id)
        if not refreshed:
            raise LookupError("simulation not found after refresh")
        return _job_payload(refreshed, "succeeded")


    limit = max(1, int(limit))

    with _JOBS_LOCK:
        job = _ACTIVE_JOBS.get(sim_id)
        if job and not job["future"].done():
            return _job_payload(sim, job.get("status"))

        # cast current_app to real Flask instance to silence Pylance
        app: Flask = cast(Flask, current_app._get_current_object())  # type: ignore[attr-defined]

        queued_row = update_simulation(
            sim_id,
            parse_status="queued",
            parse_error=None,
            parse_started_at=None,
            parse_completed_at=None,
        )
        if queued_row is None:
            raise LookupError("failed to update simulation")

        future: Future = _EXECUTOR.submit(_run_job, app, sim_id, limit, selected_only)
        _ACTIVE_JOBS[sim_id] = {"future": future, "status": "queued"}

    return _job_payload(queued_row, "queued")


def _run_job(app: Flask, sim_id: str, limit: int, selected_only: bool) -> None:
    with app.app_context():
        current_app.logger.info("[parse] job started for %s", sim_id)
        update_simulation(
            sim_id,
            parse_status="running",
            parse_started_at=_now_iso(),
            parse_error=None,
        )
        with _JOBS_LOCK:
            if sim_id in _ACTIVE_JOBS:
                _ACTIVE_JOBS[sim_id]["status"] = "running"

        try:
            result = run_parse(sim_id, limit, selected_only=selected_only)
            update_simulation(
                sim_id,
                parse_status="succeeded",
                parse_completed_at=_now_iso(),
                parse_error=None,
                parsed_person_count=result.get("count"),
            )
            current_app.logger.info(
                "[parse] job finished for %s (%s persons)",
                sim_id,
                result.get("count"),
            )
        except ParseError as exc:
            update_simulation(
                sim_id,
                parse_status="failed",
                parse_completed_at=_now_iso(),
                parse_error=str(exc),
            )
            current_app.logger.warning("[parse] job failed for %s: %s", sim_id, exc)
        except Exception as exc:
            update_simulation(
                sim_id,
                parse_status="failed",
                parse_completed_at=_now_iso(),
                parse_error=str(exc),
            )
            current_app.logger.exception("[parse] unexpected error for %s", sim_id)
        finally:
            with _JOBS_LOCK:
                _ACTIVE_JOBS.pop(sim_id, None)
