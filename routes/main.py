from datetime import datetime, timedelta

from flask import Blueprint, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from config import Config
from models import Session, db

main_bp = Blueprint("main", __name__)


@main_bp.route("/")
def index():
    return render_template("index.html")


@main_bp.route("/dashboard")
@login_required
def dashboard():
    cutoff = datetime.utcnow() - timedelta(days=Config.SESSION_EXPIRE_DAYS)
    recent = (
        Session.query.filter(
            (Session.host_id == current_user.id) | (Session.guest_id == current_user.id),
            Session.created_at >= cutoff,
        )
        .order_by(Session.created_at.desc())
        .limit(20)
        .all()
    )
    active_count = sum(1 for s in recent if s.is_active)
    return render_template(
        "dashboard.html",
        recent_sessions=recent,
        active_count=active_count,
    )


@main_bp.route("/join")
@login_required
def join():
    return render_template("join.html")