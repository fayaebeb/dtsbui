from flask import Blueprint, render_template, request, redirect, url_for, flash
from flask_login import login_user, logout_user
from .models import User, init_db
from . import login_manager


auth_bp = Blueprint("auth", __name__, url_prefix="/admin")


@login_manager.user_loader
def load_user(user_id):
    try:
        return User.get_by_id(int(user_id))
    except Exception:
        return None


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    init_db()
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = User.get_by_username(username)
        if user and user.check_password(password):
            login_user(user)
            return redirect(url_for("admin.dashboard"))
        flash("Invalid username or password", "error")
    return render_template("admin_login.html")


@auth_bp.route("/logout", methods=["POST"]) 
def logout():
    logout_user()
    return redirect(url_for("auth.login"))

