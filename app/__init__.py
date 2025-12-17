import os
import tempfile
from flask import Flask, jsonify
from flask_wtf import CSRFProtect
from flask_login import LoginManager

csrf = CSRFProtect()
login_manager = LoginManager()

def create_app():
    root = os.getcwd()
    templates = os.path.join(root, "templates")
    static = os.path.join(root, "static")

    app = Flask(__name__, template_folder=templates, static_folder=static)

    # ---- Core security/session config ----
    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", os.urandom(32))
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = False  # True when behind HTTPS

    # ---- Storage locations ----
    storage_root = os.getenv("STORAGE_ROOT", os.path.join(root, "data"))
    app.config["STORAGE_ROOT"] = storage_root
    app.config["DB_PATH"] = os.path.join(os.getenv("STORAGE_ROOT", "/home/site/storage"), "app.db")
    app.config["UPLOAD_FOLDER"] = os.path.join(storage_root, "uploads")
    parsed_dir = os.path.join(storage_root, "parsed")

    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
    os.makedirs(parsed_dir, exist_ok=True)

    # ---- Large upload settings ----
    # Total request cap (8 GB). Adjust if needed.
    app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024 * 1024  # 8 GB
    # Limit how much form data is kept in memory during parsing (Werkzeug 3.x).
    app.config["MAX_FORM_MEMORY_SIZE"] = 64 * 1024 * 1024      # 64 MB

    # ---- Temp dir for spooling (Windows-friendly) ----
    # Put temp files on the same large drive as STORAGE_ROOT to avoid filling user profile temp.
    spool_dir = os.path.join(storage_root, "tmp")
    os.makedirs(spool_dir, exist_ok=True)
    # Make Python/Werkzeug use it:
    for var in ("TMP", "TEMP", "TMPDIR"):
        os.environ[var] = spool_dir
    tempfile.tempdir = spool_dir  # extra hint

    # ---- Init extensions ----
    csrf.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = "auth.login"  # type: ignore[assignment]

    # Make csrf_token() available in templates
    from flask_wtf.csrf import generate_csrf
    @app.context_processor
    def inject_csrf():
        return dict(csrf_token=generate_csrf)

    # ---- Register blueprints ----
    from .auth import auth_bp
    from .admin_ui import admin_bp
    from .admin_api import admin_api_bp
    from .public import public_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(admin_api_bp)
    app.register_blueprint(public_bp)
    # Public pages and public API endpoints are read-only; allow JS fetch calls
    # without requiring a CSRF token.
    csrf.exempt(public_bp)

    # ---- Error handlers helpful for uploads ----
    @app.errorhandler(413)
    def too_large(_e):
        return jsonify(error="Payload too large (hit MAX_CONTENT_LENGTH)"), 413

    @app.errorhandler(400)
    def bad_request(e):
        # surface reason in local dev
        return jsonify(error=str(getattr(e, "description", "bad request"))), 400

    # ---- CLI: seed first admin ----
    @app.cli.command("create-admin")
    def create_admin_cmd():
        from .models import init_db, create_admin_if_missing
        init_db(app)
        import getpass
        username = input("Admin username: ").strip()
        password = getpass.getpass("Admin password: ")
        if not username or not password:
            print("Username and password required")
            return
        created = create_admin_if_missing(app, username, password)
        if created:
            print(f"Created admin user '{username}'.")
        else:
            print(f"User '{username}' already exists.")

    return app
