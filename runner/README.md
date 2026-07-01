# VibeBoard Python Runner

This service gives the Vercel web app a stable Python execution target without
shipping Python inside Vercel serverless functions.

## API

- `GET /health`
- `POST /v1/python/execute`

`POST /v1/python/execute` requires `Authorization: Bearer $PYTHON_RUNNER_TOKEN`
when `PYTHON_RUNNER_TOKEN` is configured.

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

## Local Run

```bash
cd runner
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
PYTHON_RUNNER_TOKEN=replace-with-long-token uvicorn app:app --host 127.0.0.1 --port 8091
```

## Vercel Environment

```bash
PYTHON_RUNNER_URL=http://150.158.146.192:7108
PYTHON_RUNNER_TOKEN=<same-long-token>
PYTHON_RUNNER_REQUIRED=false
```

If `7108` is occupied, use the fixed fallback remote port `10080`.

