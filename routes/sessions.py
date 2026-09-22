import os
import random
import uuid
from datetime import datetime

from flask import Blueprint, flash, redirect, render_template, request, send_file, url_for
from flask_login import current_user, login_required

from config import Config
from extensions import socketio
from models import File, Session, User, db

sessions_bp = Blueprint("sessions", __name__)


def _generate_code():
    while True:
        code = f"{random.randint(0, 999999):06d}"
        exists = Session.query.filter_by(session_code=code).first()
        if not exists:
            return code


def _get_session_or_404(code):
    session = Session.query.filter_by(session_code=code).first()
    if session is None:
        return None
    if current_user.id != session.host_id and (
        session.guest_id is None or current_user.id != session.guest_id
    ):
        return None
    return session


def _role_for(session):
    return "host" if current_user.id == session.host_id else "guest"


@sessions_bp.route("/sessions/create", methods=["POST"])
@login_required
def create():
    code = _generate_code()
    session = Session(session_code=code, host_id=current_user.id, status="active")
    db.session.add(session)
    db.session.commit()
    flash(f"Session {code} created. Share this code with your customer.", "success")
    return redirect(url_for("sessions.session_page", code=code))


@sessions_bp.route("/sessions/join", methods=["POST"])
@login_required
def join():
    code = (request.form.get("code") or "").strip()
    if len(code) != 6 or not code.isdigit():
        flash("Please enter a valid 6-digit session code.", "error")
        return redirect(request.referrer or url_for("main.index"))

    session = Session.query.filter_by(session_code=code).first()
    if session is None:
        flash("Session not found. Check the code and try again.", "error")
        return redirect(request.referrer or url_for("main.index"))
    if not session.is_active:
        flash("That session has already ended.", "error")
        return redirect(request.referrer or url_for("main.index"))
    if session.host_id == current_user.id:
        return redirect(url_for("sessions.session_page", code=code))
    if session.guest_id is not None and session.guest_id != current_user.id:
        flash("This session already has a customer connected.", "error")
        return redirect(request.referrer or url_for("main.index"))
    if session.guest_id is None:
        session.guest_id = current_user.id
        db.session.commit()

    return redirect(url_for("sessions.session_page", code=code))


@sessions_bp.route("/session/<code>")
@login_required
def session_page(code):
    session = _get_session_or_404(code)
    if session is None:
        flash("Session not found or you do not have access to it.", "error")
        return redirect(url_for("main.dashboard"))

    role = _role_for(session)
    files = File.query.filter_by(session_code=code).order_by(File.uploaded_at.desc()).all()
    is_host = role == "host"

    from routes.socketio_events import RECENT_MSGS

    recent_msgs = RECENT_MSGS.get(code, [])

    return render_template(
        "session.html",
        session=session,
        role=role,
        is_host=is_host,
        files=files,
        recent_msgs=recent_msgs,
        ice_servers=Config.ICE_SERVERS,
        partner_name=session.host.name if is_host else session.guest.name if session.guest else "Customer",
    )


@sessions_bp.route("/session/<code>/upload", methods=["POST"])
@login_required
def upload(code):
    session = _get_session_or_404(code)
    if session is None:
        return {"error": "Session not found."}, 404
    if not session.is_active:
        return {"error": "Session has ended."}, 400

    f = request.files.get("file")
    if f is None or f.filename == "":
        return {"error": "No file selected."}, 400

    original_name = os.path.basename(f.filename)
    if len(original_name) > 255:
        original_name = original_name[-255:]

    ext = original_name.rsplit(".", 1)[-1].lower() if "." in original_name else ""
    if ext not in Config.ALLOWED_EXTENSIONS:
        return {"error": f"File type '.{ext}' is not allowed."}, 400

    content = f.read(Config.MAX_FILE_SIZE + 1)
    if len(content) > Config.MAX_FILE_SIZE:
        return {"error": "File is too large (max 25 MB)."}, 400

    stored_name = uuid.uuid4().hex + (f".{ext}" if ext else "")
    path = os.path.join(Config.UPLOAD_FOLDER, stored_name)
    with open(path, "wb") as out:
        out.write(content)

    record = File(
        session_code=code,
        uploader_id=current_user.id,
        original_name=original_name,
        stored_name=stored_name,
        size=len(content),
    )
    db.session.add(record)
    db.session.commit()

    socketio.emit(
        "file-shared",
        {
            "id": record.id,
            "name": original_name,
            "size": len(content),
            "by": current_user.name,
            "time": record.uploaded_at.strftime("%H:%M"),
        },
        to=f"session-{code}",
    )

    return {"ok": True, "file": {"id": record.id, "name": original_name, "size": len(content)}}


@sessions_bp.route("/session/<code>/files/<int:file_id>/download")
@login_required
def download(code, file_id):
    session = _get_session_or_404(code)
    if session is None:
        return {"error": "Session not found."}, 404

    record = File.query.filter_by(id=file_id, session_code=code).first()
    if record is None:
        return {"error": "File not found."}, 404

    path = os.path.join(Config.UPLOAD_FOLDER, record.stored_name)
    if not os.path.exists(path):
        return {"error": "File is missing on the server."}, 404

    return send_file(
        path,
        as_attachment=True,
        download_name=record.original_name,
        conditional=True,
    )


@sessions_bp.route("/session/<code>/end", methods=["POST"])
@login_required
def end(code):
    session = _get_session_or_404(code)
    if session is None:
        return {"error": "Session not found."}, 404

    if session.is_active:
        session.status = "ended"
        session.ended_at = datetime.utcnow()
        db.session.commit()
        socketio.emit("session-ended", {"code": code}, to=f"session-{code}")

    flash("Session ended.", "success")
    return redirect(url_for("main.dashboard"))