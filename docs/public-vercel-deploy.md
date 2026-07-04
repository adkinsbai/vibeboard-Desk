# Public Vercel Deployment

This project can run as a public Vercel app. The current launch mode is public beta: accounts are phone + password, SMS verification is disabled, and AI usage is free while token usage is still recorded for later billing.

## Required Vercel Services

- Database: Neon Postgres from Vercel Marketplace, exposed as `DATABASE_URL`.
- LLM provider: OpenAI-compatible chat completions endpoint configured only on the server.

## Required Environment Variables

```bash
VIBEBOARD_PUBLIC_DEPLOYMENT=1
VIBEBOARD_BILLING_MODE=free
VIBEBOARD_REQUIRE_PHONE_VERIFICATION=0
DATABASE_URL=postgres://...
VIBEBOARD_ADMIN_PHONES=+8613800000000
VIBEBOARD_DB_SNAPSHOT_KEY=vibeboard-prod

VIBEBOARD_LLM_PROVIDER=deepseek
VIBEBOARD_LLM_BASE_URL=https://api.deepseek.com
VIBEBOARD_LLM_MODEL=deepseek-v4-flash
VIBEBOARD_LLM_API_KEY=...

PYTHON_RUNNER_URL=http://47.103.127.145/vibeboard-runner
PYTHON_RUNNER_TOKEN=...
PYTHON_RUNNER_REQUIRED=false
RENDER_RUNNER_REQUIRED=true
```

Do not set `VIBEBOARD_ALLOW_DEV_SMS_CODES=1` in production. It is only for local tests, where the API returns `dev_code` instead of sending SMS.

## Optional SMS Later

SMS is not required for the current public beta. When company registration and SMS templates are ready, set:

```bash
VIBEBOARD_REQUIRE_PHONE_VERIFICATION=1
VIBEBOARD_SMS_PROVIDER=aliyun-sms
ALIYUN_ACCESS_KEY_ID=...
ALIYUN_ACCESS_KEY_SECRET=...
ALIYUN_SMS_SIGN_NAME=...
ALIYUN_SMS_TEMPLATE_CODE=SMS_...
ALIYUN_SMS_TEMPLATE_PARAM={"code":"{code}"}
```

Aliyun SMS notes:

- `ALIYUN_ACCESS_KEY_ID` and `ALIYUN_ACCESS_KEY_SECRET` come from RAM AccessKey management. Use a least-privilege RAM user for production.
- `ALIYUN_SMS_SIGN_NAME` is the approved SMS signature name.
- `ALIYUN_SMS_TEMPLATE_CODE` is the approved SMS template code, such as `SMS_123456789`.
- `ALIYUN_SMS_TEMPLATE_PARAM` maps the generated code into the template variables. Use `{"code":"{code}"}` for a template with one variable, or add fields such as `{"code":"{code}","minute":"10"}` if the template requires them.
- `ALIYUN_SMS_REGION_ID` defaults to `cn-hangzhou`.

Optional Tencent Cloud SMS variables are still supported:

```bash
VIBEBOARD_SMS_PROVIDER=tencent-cloud
TENCENTCLOUD_SECRET_ID=...
TENCENTCLOUD_SECRET_KEY=...
TENCENT_SMS_SDK_APP_ID=...
TENCENT_SMS_SIGN_NAME=...
TENCENT_SMS_TEMPLATE_ID=...
TENCENT_SMS_TEMPLATE_PARAMS={code}
```

Tencent Cloud SMS notes:

- `TENCENT_SMS_SIGN_NAME` is the approved SMS signature name from the Tencent Cloud SMS console.
- `TENCENT_SMS_TEMPLATE_ID` is the approved verification-code template ID.
- `TENCENT_SMS_TEMPLATE_PARAMS` maps the generated code into template variables. Use `{code}` for a template with one variable, or `{code},10` / `{code},{minutes}` if the template also has an expiry-minutes variable.
- `TENCENT_SMS_REGION` defaults to `ap-guangzhou`.

## Credits

- Current public beta accounts receive `0` credits because AI work is free.
- `VIBEBOARD_BILLING_MODE=free` records usage with `delta=0` in `credit_ledger`.
- Later, set `VIBEBOARD_BILLING_MODE=credits` to enforce balance checks and subtract credits.
- `1 credit = 10,000 tokens`.
- This matches the requested price of `100,000 tokens = 10 RMB`.
- AI calls write entries into `credit_ledger`; provider usage is used when available, otherwise the server records an estimate.
- Users can open the Usage panel from the top bar to see token usage and estimated credits.

## Storage Model

Vercel Functions have a read-only filesystem and only `/tmp` is writable scratch space. In public deployment, auth, credits, telemetry, conversations, generated files, project memory, and jobs use Postgres tables through server-side adapters.

The older `sqlite_snapshots` table is retained only as a legacy migration source for project state that existed before the Postgres project-persistence migration. New production project-state writes do not update the SQLite snapshot blob.

## Python Runner

Vercel does not provide a durable Python or Playwright browser environment for the hardware app verification path. The production web app therefore calls the separate FastAPI runner in `runner/`:

- Local runner port on the server: `127.0.0.1:8091`.
- Public route: `http://47.103.127.145/vibeboard-runner`.
- APIs: `POST /v1/python/execute` and `POST /v1/render/verify`.
- Auth: `Authorization: Bearer $PYTHON_RUNNER_TOKEN`.

The Vercel app will use the runner for Python compile/run checks when `PYTHON_RUNNER_URL` is set. With `PYTHON_RUNNER_REQUIRED=false`, an unavailable Python runner downgrades to web preview instead of blocking the whole user flow.

Render verification is stricter in public deployment. `RENDER_RUNNER_REQUIRED` defaults to true on Vercel/public deployments, and production generation fails if the render runner is missing or unreachable. This keeps the cloud user experience aligned with local Playwright screenshot verification instead of silently skipping the 480x360 render check.

Deployment notes live in [runner/README.md](../runner/README.md).

## Admin

The phones in `VIBEBOARD_ADMIN_PHONES` become admin accounts at registration time.

Admin page:

```text
/admin.html
```

Admins can view users and the credit ledger. Credit adjustment API:

```http
POST /api/admin/credits
{
  "user_id": "...",
  "delta": 10,
  "reason": "manual_topup",
  "note": "manual adjustment"
}
```

## Known Vercel Boundary

The public web app can handle accounts, credits, chat/generation requests, project records, market preview, Python compile/run checks, and 480x360 Playwright render checks through the runner. In public deployment, hardware deployment, hardware status, logs, audio control, global preferences, and experience/playbook APIs are admin-only.

True board deployment still needs a worker/hardware service before exposing production hardware deployment to all users.
