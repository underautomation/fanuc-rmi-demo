"""
Fanuc RMI demo, Python backend: a REST API on http://localhost:16080 that drives a Fanuc robot
with the RMI protocol of the UnderAutomation Fanuc SDK, and serves the web page of the demo.

    pip install -r requirements.txt
    python app.py
"""
import json
import os
import sys
import threading
import time
import webbrowser
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path

if sys.platform != "win32":
    # Linux and macOS: use the .NET runtime instead of Mono, before the first import of the SDK
    from pythonnet import load
    load("coreclr")

from underautomation.fanuc.fanuc_robot import FanucRobot
from underautomation.fanuc.license.license_state import LicenseState

from rmi_session import DemoError, RmiSession

PORT = 16080
URL = f"http://localhost:{PORT}"
WEB_SITE = "https://fanuc-rmi-demo.underautomation.com"
HERE = Path(__file__).resolve().parent
CLIENT = HERE / "Client" if (HERE / "Client").exists() else HERE.parent / "Client"  # in the zip, or in the repository

# ---------------------------------------------------------------- settings, saved next to this file
CONFIG_PATH = HERE / "fanuc-rmi-demo.json"
config = {"ip": None, "licensee": None, "licenseKey": None}
if CONFIG_PATH.exists():
    config.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))


def save_config():
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")


def register_license():
    """Without a key, the SDK runs in its 30 day trial period"""
    if config["licenseKey"]:
        try:
            FanucRobot.register_license(config["licensee"] or "", config["licenseKey"])
        except Exception:
            pass


# ---------------------------------------------------------------- console
os.system("")  # enables the colors in the Windows console
sys.stdout.reconfigure(errors="replace")  # a message of the controller must never crash a print
GREY, RED, GREEN, ORANGE, BLUE, BOLD, END = "\033[90m", "\033[91m", "\033[32m", "\033[38;5;214m", "\033[34m", "\033[1m", "\033[0m"


def log(tag, color, message):
    print(f"{GREY}{datetime.now():%H:%M:%S}{END} {color}{tag:<5}{END} {message}", flush=True)


def banner():
    info = FanucRobot.license_info
    if info.is_licensed:
        days = info.evaluation_days_left
        license = f"{GREEN}{LicenseState(info.state).name}{END}, " + (f"{days} days left" if days is not None else info.licensee or "")
    else:
        license = f"{RED}{LicenseState(info.state).name}{END}, get a license on https://underautomation.com/fanuc"
    rows = [
        ("SDK", f"UnderAutomation.Fanuc {BOLD}{version('UnderAutomation.Fanuc')}{END} for Python"),
        ("License", license),
        ("Robot", config["ip"] or f"{GREY}not set yet{END}"),
        ("Settings", str(CONFIG_PATH)),
        ("Web page", f"{URL} or {WEB_SITE}"),
    ]
    print(f"\n  {ORANGE}{BOLD}FANUC RMI DEMO{END}  {GREY}Remote Motion Interface, driven from Python{END}\n")
    for name, value in rows:
        print(f"  {GREY}{name:<9}{END} {value}")
    print()


# ---------------------------------------------------------------- web server
session = RmiSession(lambda message: log("RMI", ORANGE, message))


def info():
    license = FanucRobot.license_info
    return {
        "backend": "python",
        "sdkVersion": version("UnderAutomation.Fanuc"),
        "license": {"state": LicenseState(license.state).name, "daysLeft": license.evaluation_days_left, "licensed": license.is_licensed},
        "config": {"ip": config["ip"], "licensee": config["licensee"]},
    }


def put_config(body):
    for key in config:
        if body.get(key) is not None:
            config[key] = str(body[key])
    save_config()
    register_license()
    log("API", BLUE, "Settings saved")
    return info()


def connect(body):
    if not isinstance(body.get("ip"), str):
        raise ValueError("ip is missing")
    session.connect(body["ip"])
    config["ip"] = body["ip"]
    save_config()
    return session.get_state()


def run(body):
    if not isinstance(body.get("steps"), list) or not all(isinstance(s, dict) for s in body["steps"]):
        raise ValueError("steps is missing")
    session.run(body["steps"], body.get("override", 10))


ROUTES = {
    ("GET", "/api/info"): lambda body: info(),
    ("PUT", "/api/config"): put_config,
    ("POST", "/api/connect"): connect,
    ("POST", "/api/disconnect"): lambda body: session.disconnect(),
    ("GET", "/api/state"): lambda body: session.get_state(),
    ("POST", "/api/run"): run,
    ("POST", "/api/pause"): lambda body: session.pause(),
    ("POST", "/api/continue"): lambda body: session.continue_(),
    ("POST", "/api/abort"): lambda body: session.abort(),
    ("POST", "/api/reset"): lambda body: session.reset(),
}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def handle_request(self):
        path = self.path.split("?")[0]
        cors = {}

        # The hosted web page calls this local API: only that page and local pages are allowed to
        origin = self.headers.get("Origin")
        if origin:
            if origin != WEB_SITE and not origin.startswith(("http://localhost:", "http://127.0.0.1:")):
                return self.reply(403, None, cors)
            cors = {
                "Access-Control-Allow-Origin": origin,
                "Vary": "Origin",
                "Access-Control-Allow-Methods": "GET, POST, PUT",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Private-Network": "true",  # public page to localhost, asked by Chrome
            }
        if self.command == "OPTIONS":
            return self.reply(204, None, cors)

        route = ROUTES.get((self.command, path))
        if route is None:
            # The web page
            return super().do_GET() if self.command == "GET" else self.reply(404, None, cors)

        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length)) if length else {}
            if not isinstance(body, dict):
                raise ValueError("The body must be a JSON object")
            self.reply(200, route(body) or {"ok": True}, cors)
        except Exception as e:
            message = getattr(e, "Message", None) or str(e)
            log("ERROR", RED, message)
            self.reply(400, {"error": message, "code": e.code if isinstance(e, DemoError) else "error"}, cors)

    do_GET = do_POST = do_PUT = do_OPTIONS = handle_request

    def reply(self, status, body, headers):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        if data:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    allow_reuse_address = False  # on Windows, reuse lets two backends listen on the same port
    daemon_threads = True


def main():
    register_license()
    banner()
    try:
        server = Server(("localhost", PORT), partial(Handler, directory=str(CLIENT)))
    except OSError:
        print(f"{RED}Port {PORT} is already used: is another backend of this demo running?{END}")
        return 1
    log("READY", GREEN, f"REST API and web page on {URL}, Ctrl+C to quit")

    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        try:
            if sys.stdin and sys.stdin.isatty() and input("Open the web page in your browser? [Y/n] ").strip().lower() in ("", "y", "yes"):
                webbrowser.open(URL)
        except EOFError:
            pass  # no console: started by a script
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        session.disconnect()  # always end the RMI session
    return 0


if __name__ == "__main__":
    sys.exit(main())
