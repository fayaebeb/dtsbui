import os
import uuid
import shutil
import zipfile
import traceback
from werkzeug.utils import secure_filename
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from .models import (
    insert_simulation,
    insert_simulation_with_id,
    list_simulations,
    update_simulation,
    delete_simulation,
    get_simulation,
)
from .azure_utils import get_storage_context
from .parse_jobs import enqueue_parse_job, get_parse_status
from typing import cast

admin_api_bp = Blueprint("admin_api", __name__, url_prefix="/admin/api")


@admin_api_bp.route("/simulations", methods=["GET"])
@login_required
def list_all():
    return jsonify(list_simulations(all_rows=True))


def _safe_extractall(zf: zipfile.ZipFile, dest: str):
    """Safely extract files from zip to dest, flattening top-level dir if present."""
    names = [zi.filename for zi in zf.infolist() if not zi.is_dir()]
    dest_abs = os.path.abspath(dest)
    common_prefix = None
    if names:
        parts = [n.split("/") for n in names if "/" in n]
        if parts:
            first_parts = parts[0][0]
            if all(p[0] == first_parts for p in parts):
                common_prefix = first_parts + "/"

    for info in zf.infolist():
        fn = info.filename
        if fn.endswith("/") or fn.endswith("\\"):
            continue
        if common_prefix and fn.startswith(common_prefix):
            fn = fn[len(common_prefix):]
        fn = fn.replace("\\", "/")
        out_path = os.path.abspath(os.path.normpath(os.path.join(dest, fn)))
        if not out_path.startswith(dest_abs):
            continue
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with zf.open(info) as src, open(out_path, "wb") as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)


@admin_api_bp.route("/simulations", methods=["POST"])
@login_required
def upload_simulation():
    """Accept a .zip upload, save to disk, extract safely, and record metadata."""
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "zip file required"}), 400

    filename = secure_filename(file.filename or "")
    if not filename.lower().endswith(".zip"):
        return jsonify({"error": "must be a .zip"}), 400

    storage_root = current_app.config["STORAGE_ROOT"]
    uploads_dir = os.path.join(storage_root, "uploads")
    os.makedirs(uploads_dir, exist_ok=True)

    sim_id = str(uuid.uuid4())
    temp_zip = os.path.join(uploads_dir, f"{sim_id}_{filename}")
    dest_folder = os.path.join(uploads_dir, sim_id)

    try:
        file.save(temp_zip)
        size_on_disk = os.path.getsize(temp_zip)
        if size_on_disk < 1024:
            raise RuntimeError("Uploaded file is empty or too small")

        os.makedirs(dest_folder, exist_ok=True)
        with zipfile.ZipFile(temp_zip, allowZip64=True) as zf:
            _safe_extractall(zf, dest_folder)

        total_size = 0
        for root, _, files in os.walk(dest_folder):
            for name in files:
                try:
                    total_size += os.path.getsize(os.path.join(root, name))
                except OSError:
                    pass

        username = cast(str, getattr(current_user, "username", "")) or ""
        row = insert_simulation_with_id(
            sim_id=sim_id,
            name=filename,
            path=dest_folder,
            size=total_size,
            uploaded_by=username,
            published=0,
            blob_name=None,
        )
        return jsonify(row), 201

    except zipfile.BadZipFile:
        current_app.logger.exception("BadZipFile while extracting.")
        return jsonify({"error": "invalid zip"}), 400
    except Exception as e:
        current_app.logger.error("Upload failed: %s", e)
        current_app.logger.debug("Traceback:\n%s", traceback.format_exc())
        return jsonify({"error": f"upload failed: {e}"}), 500
    finally:
        try:
            if os.path.exists(temp_zip):
                os.remove(temp_zip)
        except Exception:
            pass


@admin_api_bp.route("/simulations/<sim_id>", methods=["PATCH"])
@login_required
def patch_simulation(sim_id):
    payload = request.get_json(silent=True) or {}
    updates = {}
    if "published" in payload:
        updates["published"] = 1 if payload["published"] else 0
    if not updates:
        return jsonify({"error": "No updates"}), 400
    row = update_simulation(sim_id, **updates)
    if not row:
        return jsonify({"error": "Not found"}), 404
    return jsonify(row)


@admin_api_bp.route("/simulations/<sim_id>", methods=["DELETE"])
@login_required
def delete_sim(sim_id):
    row = get_simulation(sim_id)
    if not row:
        return jsonify({"error": "Not found"}), 404
    try:
        if row.get("path") and os.path.isdir(row["path"]):
            shutil.rmtree(row["path"], ignore_errors=True)
        if row.get("cached_json_path") and os.path.isfile(row["cached_json_path"]):
            os.remove(row["cached_json_path"])
    except Exception:
        pass

    blob_name = row.get("blob_name")
    if blob_name:
        try:
            bsc, _account, container, _key = get_storage_context()
            bsc.get_blob_client(container, blob_name).delete_blob()
        except Exception:
            current_app.logger.debug("Failed to delete blob %s", blob_name)

    ok = delete_simulation(sim_id)
    return ("", 204) if ok else (jsonify({"error": "Not found"}), 404)


@admin_api_bp.route("/simulations/<sim_id>/parse", methods=["POST"])
@login_required
def parse_and_cache(sim_id):
    """Kick off or inspect a parse job for the given simulation."""
    # Default to a high server-side parse limit so calculations can
    # see many persons, while the frontend can still downsample for
    # visualization.
    limit = int(request.args.get("limit", 1_000_000))
    force_flag = request.args.get("force", "0").lower() in {"1", "true", "yes"}
    all_plans_flag = request.args.get("all_plans", "0").lower() in {"1", "true", "yes"}
    selected_only = not all_plans_flag
    try:
        payload = enqueue_parse_job(sim_id, limit, force=force_flag, selected_only=selected_only)
    except LookupError:
        return jsonify({"error": "Not found"}), 404

    status = payload.get("status")
    code = 202 if status in {"queued", "running"} else 200
    return jsonify(payload), code


@admin_api_bp.route("/simulations/<sim_id>/parse/status", methods=["GET"])
@login_required
def parse_status(sim_id):
    payload = get_parse_status(sim_id)
    if not payload:
        return jsonify({"error": "Not found"}), 404
    return jsonify(payload)
