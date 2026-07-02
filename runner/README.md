# VibeBoard Python Runner

This service gives the Vercel web app a stable Python execution target without
shipping Python inside Vercel serverless functions.

## API

- `GET /health`
- `POST /v1/python/execute`
- `POST /v1/render/verify`

`POST /v1/python/execute` and `POST /v1/render/verify` require
`Authorization: Bearer $PYTHON_RUNNER_TOKEN` when `PYTHON_RUNNER_TOKEN` is
configured.

Request body:

```json
{
  "mode": "compile",
  "entry": "hardware_app.py",
  "timeoutMs": 10000,
  "files": {
    "hardware_app.py": "print('ok')"
  }
}
```

Response body:

```json
{
  "ok": true,
  "mode": "compile",
  "entry": "hardware_app.py",
  "exitCode": 0,
  "stdout": "",
  "stderr": "",
  "files": {}
}
```

When `mode` is `run`, the runner executes the entry file and returns
`hardware-result.json` when the script creates it.

`POST /v1/render/verify` receives the same generated app file map and renders
`index.html` in Playwright Chromium at the hardware screen contract size
`480x360`. It returns console/page errors, layout overflow checks, readability
checks, and a base64 screenshot in `data.screenshot.content`.

## Local Run

```bash
cd runner
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium --with-deps
PYTHON_RUNNER_TOKEN=replace-with-long-token uvicorn app:app --host 127.0.0.1 --port 8091
```

## Vercel Environment

```bash
PYTHON_RUNNER_URL=http://47.103.127.145/vibeboard-runner
PYTHON_RUNNER_TOKEN=<same-long-token>
PYTHON_RUNNER_REQUIRED=false
RENDER_RUNNER_REQUIRED=true
```

`RENDER_RUNNER_URL` and `RENDER_RUNNER_TOKEN` are optional when they are the same
as the Python runner. If omitted, render verification reuses
`PYTHON_RUNNER_URL` and `PYTHON_RUNNER_TOKEN`.
