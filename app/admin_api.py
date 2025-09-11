import os
import uuid
import shutil
import zipfile
import traceback
from werkzeug.utils import secure_filename
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from .models import insert_simulation, insert_simulation_with_id, list_simulations, update_simulation, delete_simulation, get_simulation
from .parsing import parse_plans_to_json
from typing import cast

admin_api_bp = Blueprint("admin_api", __name__, url_prefix="/admin/api")

@admin_api_bp.route("/simulations", methods=["GET"])
@login_required
def list_all():
    return jsonify(list_simulations(all_rows=True))

def _safe_extractall(zf: zipfile.ZipFile, dest: str):
    """
    Safer extract: prevents path traversal and reduces path length by flattening
    the leading directory if present. Supports Zip64.
    """
    # Try to detect a single top-level folder and drop it to shorten paths
    names = [zi.filename for zi in zf.infolist() if not zi.is_dir()]
    common_prefix = None
    if names:
        parts = [n.split("/") for n in names if "/" in n]
        if parts:
            first_parts = parts[0][0]
            if all(p[0] == first_parts for p in parts):
                common_prefix = first_parts + "/"

    for info in zf.infolist():
        fn = info.filename

        # Skip directories directly; we'll create them as needed
        if fn.endswith("/") or fn.endswith("\\"):
            continue

        # Strip a redundant top-level folder
        if common_prefix and fn.startswith(common_prefix):
            fn = fn[len(common_prefix):]

        # Normalize and prevent traversal
        fn = fn.replace("\\", "/")
        out_path = os.path.normpath(os.path.join(dest, fn))
        if not out_path.startswith(os.path.abspath(dest)):
            # path traversal attempt
            continue

        # Ensure parent exists
        os.makedirs(os.path.dirname(out_path), exist_ok=True)

        # Extract this member
        with zf.open(info) as src, open(out_path, "wb") as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)  # 1MB chunks

@admin_api_bp.route("/simulations", methods=["POST"])
@login_required
def upload_simulation():
    """
    Accepts a .zip containing a MATSim output folder.
    Streams save to disk, then extracts with Zip64 and safe paths.
    """
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
        # ---- Save zip to disk (Werkzeug streams) ----
        file.save(temp_zip)

        # Quick sanity: size > 0
        size_on_disk = os.path.getsize(temp_zip)
        if size_on_disk < 1024:
            raise RuntimeError("Uploaded file is empty or too small")

        # Ensure dest folder exists (keep extremely short path on Windows)
        os.makedirs(dest_folder, exist_ok=True)

        # ---- Extract safely with Zip64 ----
        with zipfile.ZipFile(temp_zip, allowZip64=True) as zf:
            _safe_extractall(zf, dest_folder)

        # ---- Compute folder size ----
        total_size = 0
        for root, _, files in os.walk(dest_folder):
            for name in files:
                fp = os.path.join(root, name)
                try:
                    total_size += os.path.getsize(fp)
                except OSError:
                    pass

        # ---- Record metadata ----
        username = cast(str, getattr(current_user, "username", "")) or ""
        row = insert_simulation_with_id(
            sim_id=sim_id,
            name=filename,
            path=dest_folder,
            size=total_size,
            uploaded_by=username,
            published=0
        )
        return jsonify(row), 201


    except zipfile.BadZipFile:
        current_app.logger.exception("BadZipFile while extracting.")
        return jsonify({"error": "invalid zip"}), 400
    except Exception as e:
        # LOG THE REAL REASON to the console so you can see why it failed
        current_app.logger.error("Upload failed: %s", e)
        current_app.logger.debug("Traceback:\n%s", traceback.format_exc())
        # Surface message while you’re debugging locally (helpful):
        return jsonify({"error": f"upload failed: {e}"}), 500
    finally:
        # Clean temp zip regardless of outcome
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
    # delete files on disk
    try:
        if row.get("path") and os.path.isdir(row["path"]):
            shutil.rmtree(row["path"], ignore_errors=True)
        if row.get("cached_json_path") and os.path.isfile(row["cached_json_path"]):
            os.remove(row["cached_json_path"])
    except Exception:
        pass
    ok = delete_simulation(sim_id)
    return ("", 204) if ok else (jsonify({"error": "Not found"}), 404)

@admin_api_bp.route("/simulations/<sim_id>/parse", methods=["POST"])
@login_required
def parse_and_cache(sim_id):
    sim = get_simulation(sim_id)
    if not sim:
        return jsonify({"error": "Not found"}), 404
    folder = sim["path"]

    # locate plans and optional facilities
    plan_candidates = ["output_plans.xml.gz", "output_plans.xml"]
    plans_path = next((os.path.join(folder, c) for c in plan_candidates if os.path.isfile(os.path.join(folder, c))), None)
    if not plans_path:
        return jsonify({"error": "plans file not found"}), 400

    fac_candidates = ["output_facilities.xml.gz", "facilities.xml.gz", "output_facilities.xml", "facilities.xml"]
    facilities_path = next((os.path.join(folder, c) for c in fac_candidates if os.path.isfile(os.path.join(folder, c))), None)

    persons = parse_plans_to_json(
        plans_path,
        facilities_path,
        max_persons=int(request.args.get("limit", 1000)),
        selected_only_flag=False
    )

    # store as gzip json
    import json, gzip
    parsed_dir = os.path.join(current_app.config["STORAGE_ROOT"], "parsed")
    os.makedirs(parsed_dir, exist_ok=True)
    out_path = os.path.join(parsed_dir, f"{sim_id}.json.gz")
    with gzip.open(out_path, "wt", encoding="utf-8") as g:
        json.dump(persons, g)

    row = update_simulation(sim_id, cached_json_path=out_path)
    return jsonify({"ok": True, "count": len(persons), "cache": out_path, "simulation": row})
