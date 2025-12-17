from __future__ import annotations

import threading
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime
from typing import Any, Dict, Optional, cast

import os

from flask import current_app, Flask

from .models import get_simulation
from .station_counts import StationQuery, compute_station_counts, read_station_cache


_MAX_WORKERS = int(os.getenv("STATION_WORKERS", "1") or "1")
_EXECUTOR: ThreadPoolExecutor = ThreadPoolExecutor(max_workers=max(1, _MAX_WORKERS))
_ACTIVE: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _job_key(sim_id: str, query_key: str) -> str:
    return f"{sim_id}:{query_key}"


def get_station_status(sim_id: str, q: StationQuery) -> Dict[str, Any]:
    sim = get_simulation(sim_id)
    if not sim:
        raise LookupError("simulation not found")
    query_key = q.cache_key(sim_id)
    job_id = _job_key(sim_id, query_key)

    cached = read_station_cache(sim_id, q)
    if cached:
        return {
            "status": "succeeded",
            "jobId": job_id,
            "queryKey": query_key,
            "startedAt": None,
            "completedAt": _now_iso(),
            "result": cached,
        }

    with _LOCK:
        job = _ACTIVE.get(job_id)
        if not job:
            return {
                "status": "idle",
                "jobId": job_id,
                "queryKey": query_key,
                "startedAt": None,
                "completedAt": None,
                "error": None,
            }
        future: Future = cast(Future, job.get("future"))
        if not future:
            return {"status": "failed", "jobId": job_id, "queryKey": query_key, "error": "job missing future"}
        if not future.done():
            return {
                "status": job.get("status") or "running",
                "jobId": job_id,
                "queryKey": query_key,
                "startedAt": job.get("startedAt"),
                "completedAt": None,
                "error": None,
            }
        # done
        err = job.get("error")
        res = job.get("result")
        status = "failed" if err else "succeeded"
        return {
            "status": status,
            "jobId": job_id,
            "queryKey": query_key,
            "startedAt": job.get("startedAt"),
            "completedAt": job.get("completedAt"),
            "error": err,
            "result": res,
        }


def enqueue_station_job(sim_id: str, q: StationQuery) -> Dict[str, Any]:
    sim = get_simulation(sim_id)
    if not sim:
        raise LookupError("simulation not found")

    query_key = q.cache_key(sim_id)
    job_id = _job_key(sim_id, query_key)

    with _LOCK:
        job = _ACTIVE.get(job_id)
        if job and job.get("future") and not cast(Future, job["future"]).done():
            return {
                "status": job.get("status") or "running",
                "jobId": job_id,
                "queryKey": query_key,
                "startedAt": job.get("startedAt"),
                "completedAt": None,
            }

        cached = read_station_cache(sim_id, q)
        if cached:
            return {
                "status": "succeeded",
                "jobId": job_id,
                "queryKey": query_key,
                "startedAt": None,
                "completedAt": _now_iso(),
                "result": cached,
            }

        # cast current_app to real Flask instance to ensure app context in worker
        app: Flask = cast(Flask, current_app._get_current_object())  # type: ignore[attr-defined]
        started_at = _now_iso()
        future: Future = _EXECUTOR.submit(_run_job, app, sim_id, q, job_id)
        _ACTIVE[job_id] = {
            "future": future,
            "status": "running",
            "startedAt": started_at,
            "completedAt": None,
            "error": None,
            "result": None,
        }
        return {"status": "running", "jobId": job_id, "queryKey": query_key, "startedAt": started_at}


def _run_job(app: Flask, sim_id: str, q: StationQuery, job_id: str) -> None:
    with app.app_context():
        try:
            current_app.logger.info("[station] job started %s", job_id)
            result = compute_station_counts(sim_id, q)
            with _LOCK:
                if job_id in _ACTIVE:
                    _ACTIVE[job_id]["result"] = result
                    _ACTIVE[job_id]["error"] = None
                    _ACTIVE[job_id]["status"] = "succeeded"
                    _ACTIVE[job_id]["completedAt"] = _now_iso()
            current_app.logger.info("[station] job finished %s", job_id)
        except Exception as exc:
            current_app.logger.exception("[station] job failed %s", job_id)
            with _LOCK:
                if job_id in _ACTIVE:
                    _ACTIVE[job_id]["result"] = None
                    _ACTIVE[job_id]["error"] = str(exc)
                    _ACTIVE[job_id]["status"] = "failed"
                    _ACTIVE[job_id]["completedAt"] = _now_iso()
