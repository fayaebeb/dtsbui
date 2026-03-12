import sys
import subprocess
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# --- Azure App Service fallback: ensure dependencies are installed ---
def ensure_deps():
    try:
        import flask_compress  # noqa: F401
    except ImportError:
        subprocess.check_call([
            sys.executable, "-m", "pip", "install", "-r",
            os.path.join(os.path.dirname(__file__), "requirements.txt")
        ])

ensure_deps()
# -------------------------------------------------------------------

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    def load_dotenv(*args, **kwargs) -> bool:
        return False

load_dotenv(dotenv_path=os.path.join(BASE_DIR, ".env"), override=False)

from flask import Flask, send_from_directory
from flask_compress import Compress

from app import create_app, csrf
from app.models import init_db, create_admin_if_missing


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
    from app.models import reset_stuck_jobs
    reset_stuck_jobs()

    admin_user = os.getenv("ADMIN_USER", "admin")
    admin_pass = os.getenv("ADMIN_PASS", "changeme")
    create_admin_if_missing(app, admin_user, admin_pass)


if __name__ == "__main__":
    # NOTE: The Werkzeug reloader restarts the process on file changes. This
    # interacts badly with background parse threads (ThreadPoolExecutor) and
    # can crash on Windows with WinError 10038 while a parse job is running.
    #
    # Keep debug on, but disable auto-reload by default for stability.
    debug = os.getenv("FLASK_DEBUG", "1").lower() in {"1", "true", "yes"}
    use_reloader = os.getenv("FLASK_RELOAD", "0").lower() in {"1", "true", "yes"}
    app.run(host="127.0.0.1", port=3000, debug=debug, use_reloader=use_reloader)
