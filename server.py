from dotenv import load_dotenv
load_dotenv()
from flask import Flask, send_from_directory
from flask_compress import Compress
import os
from app import create_app, csrf

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def build_app() -> Flask:
    app = create_app()
    Compress(app)

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

    return app

app = build_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=3000, debug=True)