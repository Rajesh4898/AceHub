# AssistHub - Remote Support & Screen Sharing Platform

A simple, modern web app for remote support inspired by tools like Zoho Assist.
Technicians create a session, share a 6-digit code, and the customer joins to
share their screen in real time — together with live chat and file sharing.

> The application runs fully **locally**. Real screen sharing works between two
> browsers on the same machine (or the same LAN) using WebRTC with public STUN
> servers. For exact same-code behavior on different machines, your browser must
> still be online to reach the STUN servers.

## Features

- **Landing page** with Start Remote Support / Join Session buttons
- **Authentication** — register, login, logout with secure password hashing (Werkzeug)
- **Session creation** — unique 6-digit code with a Copy button
- **Session joining** — code validation and participant checks
- **Screen sharing** — peer-to-peer WebRTC, customer consents before any stream starts
- **Live chat** — real-time messages with sender name and timestamp via Socket.IO
- **File sharing** — upload/download during a session with size and type validation
- **Session management** — End Session, Active/Ended status, and 30-day session history
- **Dashboard** — user name, create/join session, recent sessions with statuses

## Tech Stack

- Python + Flask
- Flask-SocketIO (real-time)
- WebRTC (screen sharing)
- SQLite + SQLAlchemy
- Flask-Login
- HTML/CSS/JavaScript (vanilla)

## Requirements

- Python 3.9+

## Installation

```bash
# 1. Clone or copy this project
git clone <your-repo-url> &&
cd assisthub
```

### Virtual environment setup

```bash
# macOS / Linux
python3 -m venv venv
source venv/bin/activate

# Windows
python -m venv venv
venv\Scripts\activate
```

### Dependencies

```bash
pip install -r requirements.txt
```

## How to run

```bash
python app.py
```

Then open **http://localhost:5002** in your browser.

> Port 5000/5001 are often taken by other local apps. AssistHub deliberately uses
> **5002**. To change it, edit `PORT` at the bottom of `app.py`.

## How to use AssistHub

1. **Create two accounts** (or use two different browsers/incognito windows):
   - Technician account (creates the session)
   - Customer account (joins the session)
2. **Technician:** log in → Dashboard → **Create Session** → copy the 6-digit code.
3. **Customer:** log in on the other browser → **Join Session** → enter the code.
   - Or use the **Join Session** button on the landing page.
4. Both sides land in the session room; the status chip shows connection state.
5. **Screen sharing:** the customer clicks **Start Sharing** and approves the
   browser/OS screen picker (this is the customer's consent). The technician can
   also click **Request Screen** to prompt the customer — who can approve or decline.
   The technician's screen goes live automatically; the customer's own
   **Stop Sharing** button (or the browser's screen-share stop) ends the stream.
6. **Chat:** send live messages; they appear instantly with name + timestamp.
7. **Files:** click **Choose file** then **Send File**. Both sides see the file with
   a **Download** link.
8. **End the session** with the **End Session** button in the top bar.

## Testing instructions

### Automated checks (registration, sessions, chat, files, ending)

```bash
python - <<'PY'
import json, io
from app import app

c = app.test_client()

r = c.post("/register", data={"name": "Tech", "email": "tech@test.com", "password": "password1", "confirm": "password1"}, follow_redirects=True)
assert r.status_code == 200

r = c.post("/sessions/create", follow_redirects=False)
assert r.status_code == 302
code = r.headers["Location"].rsplit("/", 1)[-1]

# guest registers and joins
g = app.test_client()
g.post("/register", data={"name": "Tina", "email": "tina@test.com", "password": "password1", "confirm": "password1"})
r = g.post("/sessions/join", data={"code": code}, follow_redirects=False)
assert r.status_code == 302 and code in r.headers["Location"]

# file upload (both as tech)
r = c.post(f"/session/{code}/upload", content_type="multipart/form-data", data={"file": (io.BytesIO(b"hello world"), "notes.txt")})
assert r.status_code == 200 and r.get_json()["ok"]

# download
r = c.get(f"/session/{code}/files/1/download")
assert r.status_code == 200 and b"hello world" in r.data

# bad file type
r = c.post(f"/session/{code}/upload", content_type="multipart/form-data", data={"file": (io.BytesIO(b"x"), "evil.exe")})
assert r.status_code == 400

# end session
r = c.post(f"/session/{code}/end", follow_redirects=False)
assert r.status_code == 302
from models import Session
rn = Session.query.filter_by(session_code=code).first()
assert rn.status == "ended"
print("All automated checks passed.")
PY
```

### Socket.IO checks (chat relay, RTC signaling relay)

```bash
python - <<'PY'
from app import app
from extensions import socketio

A = socketio.test_client(app); B = socketio.test_client(app)
# helper to create code via HTTP client (not shown) then:
A.emit("chat-message", {"code": "000001", "text": "hi"})
msgs = B.get_received()
print(msgs)
PY
```

### Manual browser test

| Test                     | Steps                                                                 | Expected |
|--------------------------|-----------------------------------------------------------------------|----------|
| Registration/login       | Sign up two accounts, log in/out                                      | Works, password hashed |
| Session creation         | Technician creates session                                            | 6-digit code shown, copied |
| Session joining          | Customer joins with the code; wrong code shows an error               | Connected, error handled |
| Screen sharing           | Customer shares screen, technician views it live, stop works          | Live video both sides |
| Chat                     | Both send messages                                                    | Instant delivery with sender/time |
| File sharing             | Upload a file, download it on the other side                          | File listed + downloads |
| Ending sessions          | Either side ends the session                                          | Status → Ended, redirect |
| Database operations      | Sessions persisted in `database/assisthub.db`                        | Rows created/updated |

## Project Structure

```text
assisthub/
├── app.py                  # app factory + Socket.IO entrypoint
├── config.py               # config, upload rules, ICE servers
├── extensions.py           # shared Socket.IO instance
├── requirements.txt
├── README.md
├── models/                 # SQLAlchemy models + Flask-Login
├── routes/                 # blueprints + Socket.IO handlers
├── templates/              # Jinja templates
├── static/
│   ├── css/
│   └── js/
├── uploads/                # session files (gitignored)
└── database/               # SQLite db (gitignored)
```

## Security notes

- Passwords are hashed with Werkzeug (never stored in plain text).
- All dashboard/session pages require login; session pages verify membership.
- Session codes are unique and validated.
- Screen sharing only starts after the customer explicitly consents
  (browser screen picker + optional technician request prompt).
- Uploaded files are stored under randomized names; extension and size are
  validated; only session participants can download.
- In production, set a strong `SECRET_KEY` environment variable and run behind a
  real WSGI server. For public/remote use over the internet you would also add a
  TURN server (e.g. coturn) to the ICE config.