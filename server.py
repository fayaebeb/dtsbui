try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    def load_dotenv(*args, **kwargs) -> bool:
        return False

load_dotenv()

import os
from flask import Flask, send_from_directory
from flask_compress import Compress

from app import create_app, csrf
from app.models import init_db, create_admin_if_missing

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def build_app() -> Flask:
    app = create_app()
    Compress(app)

    try:
        from app.admin_uploads import bp as admin_uploads_bp
        app.register_blueprint(admin_uploads_bp)
    except Exception:
        pass

    from story_api import story_bp
    csrf.exempt(story_bp)
    app.register_blueprint(story_bp)

    @app.route("/matsim_data/<path:filename>")
    def matsim_files(filename):
        return send_from_directory(os.path.join(BASE_DIR, "matsim_data"), filename)

    @app.route("/assets/<path:filename>")
    def assets_files(filename):
        return send_from_directory(os.path.join(BASE_DIR, "assets"), filename)

    @app.route("/<path:filename>")
    def root_static(filename):
        return send_from_directory(BASE_DIR, filename)

    @app.route("/")
    def index():
        return send_from_directory(BASE_DIR, "index.html")

    @app.route("/healthz")
    def healthz():
        return "ok", 200

    return app

app = build_app()

with app.app_context():
    init_db(app)
    admin_user = os.getenv("ADMIN_USER", "admin")
    admin_pass = os.getenv("ADMIN_PASS", "changeme")
    create_admin_if_missing(app, admin_user, admin_pass)

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=3000, debug=True)