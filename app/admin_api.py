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
from .parsing import parse_plans_to_json
from typing import cast

admin_api_bp = Blueprint("admin_api", __name__, url_prefix="/admin/api")


@admin_api_bp.route("/simulations", methods=["GET"])
@login_required
def list_all():
    return jsonify(list_simulations(all_rows=True))


def _safe_extractall(zf: zipfile.ZipFile, dest: str):
    """Safely extract files from zip to dest, flattening top-level dir if present."""
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
        if fn.endswith("/") or fn.endswith("\\"):
            continue
        if common_prefix and fn.startswith(common_prefix):
            fn = fn[len(common_prefix):]
        fn = fn.replace("\\", "/")
        out_path = os.path.normpath(os.path.join(dest, fn))
        if not out_path.startswith(os.path.abspath(dest)):
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
    """Parse plans/facilities from a simulation (local folder or blob)."""
    import tempfile, json, gzip
    from azure.storage.blob import BlobClient

    sim = get_simulation(sim_id)
    if not sim:
        return jsonify({"error": "Not found"}), 404

    plans_path = None
    facilities_path = None

    folder = sim.get("path")
    if folder and os.path.isdir(folder):
        current_app.logger.info(f"[parse] using local folder {folder}")
        plan_candidates = ["output_plans.xml.gz", "output_plans.xml"]
        plans_path = next((os.path.join(folder, c) for c in plan_candidates
                           if os.path.isfile(os.path.join(folder, c))), None)
        fac_candidates = ["output_facilities.xml.gz","facilities.xml.gz",
                          "output_facilities.xml","facilities.xml"]
        facilities_path = next((os.path.join(folder, c) for c in fac_candidates
                                if os.path.isfile(os.path.join(folder, c))), None)
        if not plans_path:
            return jsonify({"error": "plans file not found in local folder"}), 400

    else:
        blob_name = sim.get("blob_name")
        if not blob_name:
            return jsonify({"error": "No path or blob available"}), 400

        bsc, account, container, _key = get_storage_context()
        blob: BlobClient = bsc.get_blob_client(container, blob_name)

        def _find_member(zf, wanted_names):
            wanted = [w.lower() for w in wanted_names]
            for info in zf.infolist():
                if info.is_dir():
                    continue
                base = os.path.basename(info.filename).lower()
                if base in wanted:
                    return info.filename
            return None

        with tempfile.TemporaryDirectory(dir=current_app.config["STORAGE_ROOT"]) as tmpd:
            tmp_zip = os.path.join(tmpd, "sim.zip")
            current_app.logger.info(f"[parse] downloading blob {blob_name} → {tmp_zip}")
            with open(tmp_zip, "wb") as f:
                blob.download_blob().readinto(f)

            with zipfile.ZipFile(tmp_zip, "r") as zf:
                plan_member = _find_member(zf, ["output_plans.xml.gz", "output_plans.xml"])
                fac_member  = _find_member(zf, ["output_facilities.xml.gz","facilities.xml.gz",
                                                 "output_facilities.xml","facilities.xml"])

                if not plan_member:
                    current_app.logger.error("[parse] plans file not found in zip")
                    return jsonify({"error": "plans file not found in zip"}), 400

                dst_plan = os.path.join(tmpd, os.path.basename(plan_member))
                with zf.open(plan_member) as src, open(dst_plan, "wb") as dst:
                    shutil.copyfileobj(src, dst, length=1024 * 1024)
                plans_path = dst_plan

                if fac_member:
                    dst_fac = os.path.join(tmpd, os.path.basename(fac_member))
                    with zf.open(fac_member) as src, open(dst_fac, "wb") as dst:
                        shutil.copyfileobj(src, dst, length=1024 * 1024)
                    facilities_path = dst_fac

                current_app.logger.info(f"[parse] found plans={plan_member}, facilities={fac_member or 'none'}")

                persons = parse_plans_to_json(
                    plans_path,
                    facilities_path,
                    max_persons=int(request.args.get("limit", 1000)),
                    selected_only_flag=False,
                )

                parsed_dir = os.path.join(current_app.config["STORAGE_ROOT"], "parsed")
                os.makedirs(parsed_dir, exist_ok=True)
                out_path = os.path.join(parsed_dir, f"{sim_id}.json.gz")
                with gzip.open(out_path, "wt", encoding="utf-8") as g:
                    json.dump(persons, g)

                row = update_simulation(sim_id, cached_json_path=out_path)
                current_app.logger.info(f"[parse] cached {len(persons)} persons → {out_path}")
                return jsonify({"ok": True, "count": len(persons), "cache": out_path, "simulation": row})

    # Local-folder parse
    persons = parse_plans_to_json(
        plans_path,
        facilities_path,
        max_persons=int(request.args.get("limit", 1000)),
        selected_only_flag=False,
    )
    parsed_dir = os.path.join(current_app.config["STORAGE_ROOT"], "parsed")
    os.makedirs(parsed_dir, exist_ok=True)
    out_path = os.path.join(parsed_dir, f"{sim_id}.json.gz")
    with gzip.open(out_path, "wt", encoding="utf-8") as g:
        json.dump(persons, g)

    row = update_simulation(sim_id, cached_json_path=out_path)
    current_app.logger.info(f"[parse] cached {len(persons)} persons → {out_path}")
    return jsonify({"ok": True, "count": len(persons), "cache": out_path, "simulation": row})