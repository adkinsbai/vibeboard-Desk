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

Vercel Functions have a read-only filesystem and only `/tmp` is writable scratch space. In public deployment, auth and credits use Postgres tables directly. The existing SQLite-backed project/conversation/job stores are also snapshotted into Neon through `sqlite_snapshots`, keyed by `VIBEBOARD_DB_SNAPSHOT_KEY`, so public state survives function restarts.

This snapshot bridge is a production bootstrap. For higher concurrency, migrate the remaining stores into first-class Postgres tables or a worker service.

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

The public web app can handle accounts, credits, chat/generation requests, and project records. In public deployment, hardware deployment, hardware status, logs, audio control, global preferences, and experience/playbook APIs are admin-only. Local hardware operations such as Python verification, Playwright browser rendering, SSH deploy, and persistent filesystem project folders are not a good fit for Vercel Serverless storage/runtime.

Public Vercel mode therefore caps Agent generation to a shorter cloud-safe run and disables automatic local repair/verification attempts. Move the full L0-L4 verification and real board deployment path into a separate worker/runner service before exposing production hardware deployment to all users.
