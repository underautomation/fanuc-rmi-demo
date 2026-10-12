"""
Checks a running backend (.NET or Python, same REST API) against a robot. It MOVES the robot: 30 mm up and down.

    python tests/test_api.py 192.168.0.1
    python tests/test_api.py 192.168.0.1 --fault    also sends a target out of reach, to check the recovery
"""
import json
import sys
import time
import urllib.error
import urllib.request

API = "http://localhost:16080/api"


def call(method, path, body=None, origin=None):
    headers = {"Content-Type": "application/json"}
    if origin:
        headers["Origin"] = origin
    request = urllib.request.Request(API + path, json.dumps(body).encode() if body is not None else None, headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read() or "null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "null")


def run_and_wait(steps, timeout=30):
    assert call("POST", "/run", {"steps": steps, "override": 20})[0] == 200
    end = time.time() + timeout
    while time.time() < end:
        state = call("GET", "/state")[1]
        if state["run"]["state"] not in ("running", "paused"):
            return state
        time.sleep(0.2)
    raise AssertionError(f"sequence still running after {timeout} s: {state['run']}")


def main(ip, fault):
    status, info = call("GET", "/info")
    assert status == 200 and info["backend"] in ("dotnet", "python"), info
    print(f"backend {info['backend']}, SDK {info['sdkVersion']}, license {info['license']['state']}")

    assert call("GET", "/state", origin="https://evil.example")[0] == 403, "a foreign web site must be rejected"
    assert call("GET", "/state", origin="https://fanuc-rmi-demo.underautomation.com")[0] == 200
    assert call("POST", "/run", {"steps": [], "override": 20})[1]["code"] == "not_connected"

    # Why a connection fails
    assert call("POST", "/connect", {"ip": "192.0.2.1"})[1]["code"] == "unreachable"      # nobody at this address
    assert call("POST", "/connect", {"ip": "127.0.0.1"})[1]["code"] == "no_rmi"           # a host without RMI
    assert call("POST", "/connect", {})[0] == 400

    status, state = call("POST", "/connect", {"ip": ip})
    assert status == 200 and state["connected"], state
    assert call("GET", "/info")[1]["config"]["ip"] == ip, "the address of the robot must be saved"
    z = state["position"]["cartesian"][2]
    print("connected,", state["controller"])

    # Rejected before anything is sent to the robot
    assert call("POST", "/run", {"steps": [{"id": "a", "type": "linear", "v": [0, 0], "speed": 50}]})[0] == 400
    assert call("POST", "/run", {"steps": [{"id": "a", "type": "joint", "v": [0] * 6, "speed": 500}]})[0] == 400
    assert call("POST", "/run", {"steps": [{"id": "a", "type": "fly"}]})[0] == 400

    up = {"id": "up", "type": "linear_rel", "v": [0, 0, 30, 0, 0, 0], "speed": 100, "cnt": 0}
    down = {"id": "down", "type": "linear_rel", "v": [0, 0, -30, 0, 0, 0], "speed": 100, "cnt": 50}
    state = run_and_wait([
        up,
        {"id": "wait", "type": "wait", "seconds": 0.3},
        {"id": "on", "type": "set_do", "port": 1, "on": True},
        down,                                             # CNT with nothing to blend with: sent as FINE
        {"id": "off", "type": "set_do", "port": 1, "on": False},
        {"id": "last", "type": "wait", "seconds": 0.2},   # a wait that nothing follows
    ])
    assert state["run"]["state"] == "done", state["run"]
    assert [s["status"] for s in state["run"]["steps"]] == ["Completed"] * 6, state["run"]
    assert abs(state["position"]["cartesian"][2] - z) < 0.5, "the robot must be back at its start height"
    print("sequence completed")

    # Abort in the middle of a sequence
    assert call("POST", "/run", {"steps": [up, {"id": "w", "type": "wait", "seconds": 20}, down], "override": 20})[0] == 200
    assert call("POST", "/run", {"steps": [up]})[1]["code"] == "already_running"
    time.sleep(2.5)
    assert call("POST", "/abort")[0] == 200
    time.sleep(0.5)
    assert call("GET", "/state")[1]["run"]["state"] == "aborted"
    assert run_and_wait([down])["run"]["state"] == "done"
    print("abort ok")

    if fault:
        check_fault(up, down)

    assert call("POST", "/disconnect")[0] == 200
    assert call("GET", "/state")[1]["connected"] is False
    print("ALL OK")


def check_fault(up, down):
    # A target that the robot cannot reach
    state = run_and_wait([{"id": "far", "type": "linear_rel", "v": [0, 0, 9000, 0, 0, 0], "speed": 100, "cnt": 0}])
    assert state["run"]["state"] == "error" and state["run"]["error"], state["run"]
    print("unreachable target:", state["run"]["error"], "| last error:", state["controller"]["lastError"])
    assert call("POST", "/reset")[0] == 200
    assert run_and_wait([up, down])["run"]["state"] == "done", "the robot must move again after a reset"
    print("reset ok")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1], "--fault" in sys.argv)
