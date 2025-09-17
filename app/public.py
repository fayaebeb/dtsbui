import json
import os
import gzip
import datetime
from flask import Blueprint, render_template, jsonify, current_app, send_file, send_from_directory
from azure.storage.blob import generate_blob_sas, BlobSasPermissions

from .models import list_simulations, get_simulation
from .parsing import parse_plans_to_json
from .azure_utils import get_storage_context


public_bp = Blueprint("public", __name__)


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
            "has_blob": bool(r.get("blob_name"))
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
    if cache and os.path.isfile(cache):
        with gzip.open(cache, "rt", encoding="utf-8") as g:
            persons = json.load(g)
        return jsonify(persons)
    # Parse on the fly
    folder = sim["path"]
    candidates = ["output_plans.xml.gz", "output_plans.xml"]
    plans_path = None
    for c in candidates:
        p = os.path.join(folder, c)
        if os.path.isfile(p):
            plans_path = p
            break
    if not plans_path:
        return jsonify({"error": "plans file not found"}), 400
    fac_candidates = [
        "output_facilities.xml.gz",
        "facilities.xml.gz",
        "output_facilities.xml",
        "facilities.xml",
    ]
    facilities_path = None
    for c in fac_candidates:
        p = os.path.join(folder, c)
        if os.path.isfile(p):
            facilities_path = p
            break
    persons = parse_plans_to_json(plans_path, facilities_path, max_persons=int(os.getenv("PUBLIC_MAX_PERSONS", "1000")), selected_only_flag=False)
    return jsonify(persons)





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
