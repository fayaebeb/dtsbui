from dotenv import load_dotenv
load_dotenv()
from flask import Flask
from flask_compress import Compress

# Use app factory with auth/admin/public blueprints
from app import create_app, csrf


def build_app() -> Flask:
    app = create_app()
    # Optional: enable gzip compression for large JSON payloads
    Compress(app)
    # Register existing story blueprint
    from story_api import story_bp
    csrf.exempt(story_bp)
    app.register_blueprint(story_bp)
    return app


app = build_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
