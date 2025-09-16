import os
import io
import zipfile
import tempfile
import datetime
from typing import cast

from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user

from azure.storage.blob import (
    BlobServiceClient,
    BlobClient,
    generate_blob_sas,
    BlobSasPermissions,
)

from app.models import insert_simulation_with_id

bp = Blueprint("admin_uploads", __name__, url_prefix="/admin/api")

def _storage():
    conn = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
    acct = os.getenv("AZURE_STORAGE_ACCOUNT")
    cont = os.getenv("AZURE_STORAGE_CONTAINER")
    if not cont:
        raise RuntimeError("AZURE_STORAGE_CONTAINER is not set")
    if conn:
        bsc = BlobServiceClient.from_connection_string(conn)
        account = bsc.account_name
    else:
        if not acct:
            raise RuntimeError("AZURE_STORAGE_ACCOUNT or CONNECTION_STRING is required")
        bsc = BlobServiceClient(account_url=f"https://{acct}.blob.core.windows.net/")
        account = acct
    return bsc, account, cont

@bp.route("/upload-sas", methods=["POST"])
@login_required
def upload_sas():
    """
    Body: { "filename": "my-sim.zip" }
    Returns: { "sasUrl": "https://<acct>.blob.core.windows.net/<container>/<filename>?<sas>" }
    """
    payload = request.get_json(silent=True) or {}
    filename = payload.get("filename", "").strip()
    if not filename:
        return jsonify({"error": "filename required"}), 400

    bsc, account, container = _storage()

    try:
        bsc.get_container_client(container).create_container()
    except Exception:
        pass

    conn = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
    key = os.getenv("AZURE_STORAGE_KEY")
    if not conn and not key:
        return jsonify({"error": "Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_KEY"}), 500

    if not account:
        return jsonify({"error": "AZURE_STORAGE_ACCOUNT is not set"}), 500

    sas = generate_blob_sas(
        account_name=account,
        container_name=container,
        blob_name=filename,
        account_key=key if not conn else None,
        permission=BlobSasPermissions(write=True, create=True, add=True),
        expiry=datetime.datetime.utcnow() + datetime.timedelta(hours=1),
    )
    url = f"https://{account}.blob.core.windows.net/{container}/{filename}?{sas}"
    return jsonify({"sasUrl": url})

@bp.route("/simulations/import-from-blob", methods=["POST"])
@login_required
def import_from_blob():
    """
    Body: { "filename": "my-sim.zip" }
    Downloads the blob, extracts to STORAGE_ROOT/uploads/<sim_id>, inserts a DB row.
    """
    payload = request.get_json(silent=True) or {}
    filename = payload.get("filename", "").strip()
    if not filename:
        return jsonify({"error": "filename required"}), 400

    bsc, account, container = _storage()
    blob_url = f"https://{account}.blob.core.windows.net/{container}/{filename}"
    blob: BlobClient = bsc.get_blob_client(container, filename)

    storage_root = current_app.config.get("STORAGE_ROOT", os.path.join(os.getcwd(), "data"))
    os.makedirs(storage_root, exist_ok=True)
    uploads_root = os.path.join(storage_root, "uploads")
    os.makedirs(uploads_root, exist_ok=True)

    import uuid
    sim_id = f"{os.path.splitext(filename)[0]}-{uuid.uuid4().hex[:8]}"
    dest_folder = os.path.join(uploads_root, sim_id)
    os.makedirs(dest_folder, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=storage_root) as tmpd:
        tmp_zip = os.path.join(tmpd, "upload.zip")
        with open(tmp_zip, "wb") as f:
            downloader = blob.download_blob(max_concurrency=4)
            downloader.readinto(f)

        with zipfile.ZipFile(tmp_zip, "r", allowZip64=True) as zf:
            for m in zf.infolist():
                # prevent path traversal
                name = m.filename
                if ".." in name or name.startswith("/") or name.startswith("\\"):
                    continue
                target_path = os.path.normpath(os.path.join(dest_folder, name))
                if not target_path.startswith(dest_folder):
                    continue
                if m.is_dir():
                    os.makedirs(target_path, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    with zf.open(m) as src, open(target_path, "wb") as out:
                        out.write(src.read())

    total_size = 0
    for root, _, files in os.walk(dest_folder):
        for n in files:
            fp = os.path.join(root, n)
            try:
                total_size += os.path.getsize(fp)
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
    )
    return jsonify({"ok": True, "simulation": row, "blobUrl": blob_url})
