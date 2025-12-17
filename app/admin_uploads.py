import os
import zipfile
import tempfile
import datetime
import uuid
from typing import cast

from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from werkzeug.utils import secure_filename

from azure.storage.blob import BlobClient, generate_blob_sas, BlobSasPermissions

from app.azure_utils import get_storage_context
from app.models import insert_simulation_with_id

bp = Blueprint("admin_uploads", __name__, url_prefix="/admin/api")


@bp.route("/upload-sas", methods=["POST"])
@login_required
def upload_sas():
    """Return a write SAS URL for uploading a simulation zip directly to Azure."""
    payload = request.get_json(silent=True) or {}
    filename = secure_filename((payload.get("filename") or "").strip())
    if not filename:
        return jsonify({"error": "filename required"}), 400
    if not filename.lower().endswith(".zip"):
        return jsonify({"error": "must be a .zip"}), 400

    prefix = secure_filename((payload.get("prefix") or "simulations").strip()) or "simulations"
    blob_name = f"{prefix}/{uuid.uuid4().hex}_{filename}"

    # In local development we may not have Azure configured; surface a clean
    # JSON error instead of a 500 so the frontend can fall back to direct upload.
    try:
        bsc, account, container, account_key = get_storage_context(require_account_key=True)
    except RuntimeError as exc:
        current_app.logger.error("Azure storage not configured for upload_sas: %s", exc)
        return jsonify({"error": "blob_storage_not_configured"}), 400
    container_client = bsc.get_container_client(container)
    try:
        container_client.create_container()
    except Exception:
        pass

    expiry = datetime.datetime.utcnow() + datetime.timedelta(hours=1)
    sas = generate_blob_sas(
        account_name=account,
        container_name=container,
        blob_name=blob_name,
        account_key=account_key,
        permission=BlobSasPermissions(write=True, create=True, add=True),
        expiry=expiry,
    )
    blob_url = f"https://{account}.blob.core.windows.net/{container}/{blob_name}"
    return jsonify(
        {
            "sasUrl": f"{blob_url}?{sas}",
            "blobName": blob_name,
            "blobUrl": blob_url,
            "expiresAt": expiry.isoformat() + "Z",
        }
    )


@bp.route("/simulations/import-from-blob", methods=["POST"])
@login_required
def import_from_blob():
    """
    Body: { "blob_name": "simulations/uuid_file.zip", "original_name": "file.zip" }
    Downloads the blob, extracts it locally under STORAGE_ROOT/uploads/<sim_id>, and stores metadata.
    """
    payload = request.get_json(silent=True) or {}
    blob_name = (payload.get("blob_name") or payload.get("filename") or "").strip()
    if not blob_name:
        return jsonify({"error": "blob_name required"}), 400

    display_name = (payload.get("original_name") or os.path.basename(blob_name)).strip() or os.path.basename(blob_name)

    bsc, account, container, _key = get_storage_context()
    blob: BlobClient = bsc.get_blob_client(container, blob_name)

    try:
        props = blob.get_blob_properties()
    except Exception:
        return jsonify({"error": "Blob not found"}), 404

    storage_root = current_app.config.get("STORAGE_ROOT", os.path.join(os.getcwd(), "data"))
    os.makedirs(storage_root, exist_ok=True)
    uploads_root = os.path.join(storage_root, "uploads")
    os.makedirs(uploads_root, exist_ok=True)

    sim_id = uuid.uuid4().hex
    dest_folder = os.path.join(uploads_root, sim_id)
    os.makedirs(dest_folder, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=storage_root) as tmpd:
        tmp_zip = os.path.join(tmpd, "upload.zip")
        with open(tmp_zip, "wb") as f:
            downloader = blob.download_blob(max_concurrency=4)
            downloader.readinto(f)

        with zipfile.ZipFile(tmp_zip, "r", allowZip64=True) as zf:
            for member in zf.infolist():
                name = member.filename
                if ".." in name or name.startswith("/") or name.startswith("\\"):
                    continue
                target_path = os.path.normpath(os.path.join(dest_folder, name))
                if not target_path.startswith(dest_folder):
                    continue
                if member.is_dir():
                    os.makedirs(target_path, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    with zf.open(member) as src, open(target_path, "wb") as out:
                        out.write(src.read())

    total_size = 0
    for root, _dirs, files in os.walk(dest_folder):
        for name in files:
            fp = os.path.join(root, name)
            try:
                total_size += os.path.getsize(fp)
            except OSError:
                pass

    username = cast(str, getattr(current_user, "username", "")) or ""
    row = insert_simulation_with_id(
        sim_id=sim_id,
        name=display_name,
        path=dest_folder,
        size=total_size,
        uploaded_by=username,
        published=0,
        blob_name=blob_name,
    )
    return jsonify({
        "ok": True,
        "simulation": row,
        "blobUrl": blob.url,
        "blobSize": getattr(props, "size", None),
    })


@bp.route("/simulations/register-blob", methods=["POST"])
@login_required
def register_blob():
    """
    Body: { "blob_name": "simulations/<uuid>_file.zip", "original_name": "file.zip" }
    Creates a DB row pointing at the blob. No extraction here.
    """
    from flask_login import current_user
    from typing import cast
    import os, uuid
    from .models import insert_simulation_with_id
    from .azure_utils import get_storage_context
    from azure.storage.blob import BlobClient

    payload = request.get_json(silent=True) or {}
    blob_name = (payload.get("blob_name") or "").strip()
    display_name = (payload.get("original_name") or os.path.basename(blob_name)).strip() or os.path.basename(blob_name)
    if not blob_name:
        return jsonify({"error": "blob_name required"}), 400

    bsc, account, container, _key = get_storage_context()
    blob: BlobClient = bsc.get_blob_client(container, blob_name)

    try:
        props = blob.get_blob_properties()
    except Exception:
        return jsonify({"error": "Blob not found"}), 404

    # We still keep a local root for DB/parsed cache; but we DO NOT extract the ZIP here.
    storage_root = current_app.config.get("STORAGE_ROOT", "/home/site/storage")
    os.makedirs(storage_root, exist_ok=True)

    sim_id = uuid.uuid4().hex
    username = cast(str, getattr(current_user, "username", "")) or ""
    row = insert_simulation_with_id(
        sim_id=sim_id,
        name=display_name,
        path="",              # no local extraction path
        size=getattr(props, "size", None) or 0,
        uploaded_by=username,
        published=0,
        blob_name=blob_name,  # **this** is how we locate the file later
    )
    return jsonify({"ok": True, "simulation": row})
