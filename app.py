from flask import Flask

from config import Config
from extensions import socketio
from models import db, login_manager


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    db.init_app(app)
    login_manager.init_app(app)
    socketio.init_app(app)

    with app.app_context():
        db.create_all()

    from routes.auth import auth_bp
    from routes.main import main_bp
    from routes.sessions import sessions_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(main_bp)
    app.register_blueprint(sessions_bp)

    from routes.socketio_events import register_socket_handlers

    register_socket_handlers(socketio, app)

    return app


app = create_app()

PORT = 5002
if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=PORT, debug=True, allow_unsafe_werkzeug=True)