# AGENTS.md

Block-based web page that drives a Fanuc robot over RMI, with two interchangeable backends (.NET and Python) built on the UnderAutomation Fanuc SDK.

## Layout

- `src/Client/` — static web page (vanilla JS, no build step). `blocks.js` = block model, `codegen.js` = C#/Python code generation, `mock.js` = demo-mode simulated robot.
- `src/Backend.DotNet/` — .NET 9 backend (`Program.cs`, `RmiSession.cs`). Serves `src/Client` on `http://localhost:16080`.
- `src/Backend.Python/` — Python backend (`app.py`, `rmi_session.py`). Same HTTP API as the .NET one.
- `tests/` — `blocks.test.mjs` (Node, offline) and `test_api.py` (against a real or simulated controller).

## Commands

```bash
node tests/blocks.test.mjs                 # blocks + generated code, no robot needed
cd src/Backend.DotNet && dotnet run        # .NET backend
cd src/Backend.Python && python app.py     # Python backend (use its .venv)
build_all.cmd                              # dist/FanucRmiDemo.exe + fanuc-rmi-demo-python.zip
python tests/test_api.py <robot-ip>        # API test, needs a robot
```

## Rules

- Keep both backends in sync: any API or behavior change goes in `.NET` and `Python`, and the client must work with either.
- The client must stay static and dependency-free (vendored libs in `src/Client/vendor`).
- A change to blocks or generated code needs a matching update in `tests/blocks.test.mjs`.
- Use the SDK skills (`underautomation-fanuc-csharp`, `underautomation-fanuc-python`) for SDK questions instead of guessing the API.
- Releases are made by pushing a `v*` tag (`.github/workflows/deploy.yml`); do not deploy by hand.

## Robot safety

- Never run motion tests on a real robot without the user's explicit go.
- Always `POST /api/disconnect` before stopping a backend: a killed backend leaves `RMI_MOVE` selected on the controller and blocks the next run.
- `test_api.py --fault` can wedge the controller; run it only when the user can reset it.
- Avoid `GetExtendedStatus()` on the simulator: it hangs.
