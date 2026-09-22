import os

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DATABASE_DIR = os.path.join(BASE_DIR, "database")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")

os.makedirs(DATABASE_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "assisthub-dev-secret-change-me")
    SQLALCHEMY_DATABASE_URI = "sqlite:///" + os.path.join(DATABASE_DIR, "assisthub.db")
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    UPLOAD_FOLDER = UPLOAD_DIR
    MAX_CONTENT_LENGTH = 26 * 1024 * 1024  # 26 MB (file cap is 25 MB)
    MAX_FILE_SIZE = 25 * 1024 * 1024
    MAX_CHAT_LENGTH = 1000
    SESSION_EXPIRE_DAYS = 30

    ALLOWED_EXTENSIONS = {
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
        "pdf", "txt", "md", "csv", "json", "log", "xml",
        "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
        "zip", "rar", "7z", "tar", "gz",
        "mp4", "webm", "mp3", "wav", "ogg",
    }

    # public STUN servers used for WebRTC (no TURN server in local/simple setup)
    ICE_SERVERS = [
        {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}
    ]