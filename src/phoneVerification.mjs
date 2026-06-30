import crypto from "node:crypto";

export function createPhoneVerificationService({ authStore, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!authStore) throw new Error("authStore is required");

  async function sendCode({ phone, purpose = "register" } = {}) {
    const code = generateCode();
    const verification = await authStore.createVerification({ phone, purpose, code });
    const provider = providerName(env);
    const allowDevCode = provider === "dev" && (env.VIBEBOARD_ALLOW_DEV_SMS_CODES === "1" || !isPublicDeployment(env));
    if (provider === "dev" && !allowDevCode) {
      const error = new Error("SMS provider is not configured.");
      error.statusCode = 503;
      throw error;
    }
    const sent = await sendSms({ env, fetchImpl, phone: verification.phone, code, purpose, provider });
    const payload = {
      ok: true,
      phone: verification.phone,
      provider,
      expires_at: verification.expires_at,
      sent,
    };
    if (!sent && allowDevCode) {
      payload.dev_code = code;
      payload.warning = "SMS provider is not configured; dev_code is returned for local development.";
    }
    return payload;
  }

  async function verifyCode(input = {}) {
    return authStore.verifyPhoneCode(input);
  }

  return { sendCode, verifyCode };
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function providerName(env) {
  const explicit = String(env.VIBEBOARD_SMS_PROVIDER || "").trim().toLowerCase();
  if (["aliyun-sms", "tencent-cloud", "twilio", "dev"].includes(explicit)) return explicit;
  if (hasCompleteAliyunSmsConfig(env)) return "aliyun-sms";
  if (hasCompleteTencentSmsConfig(env)) return "tencent-cloud";
  if (hasCompleteTwilioConfig(env)) return "twilio";
  if (hasAnyAliyunSmsConfig(env)) return "aliyun-sms";
  if (hasAnyTencentSmsConfig(env)) return "tencent-cloud";
  return "dev";
}

function isPublicDeployment(env) {
  return env.VERCEL === "1" || env.VIBEBOARD_PUBLIC_DEPLOYMENT === "1";
}

async function sendSms({ env, fetchImpl, phone, code, purpose, provider }) {
  if (provider === "aliyun-sms") {
    await sendAliyunSms({ env, fetchImpl, phone, code });
    return true;
  }
  if (provider === "tencent-cloud") {
    await sendTencentSms({ env, fetchImpl, phone, code });
    return true;
  }
  if (provider === "twilio") {
    const sid = env.TWILIO_ACCOUNT_SID;
    const token = env.TWILIO_AUTH_TOKEN;
    const from = env.TWILIO_FROM_PHONE;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
    const body = new URLSearchParams({
      To: phone,
      From: from,
      Body: smsBody(code, purpose),
    });
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`SMS provider failed: ${response.status} ${text.slice(0, 200)}`);
      error.statusCode = 502;
      throw error;
    }
    return true;
  }
  return false;
}

async function sendAliyunSms({ env, fetchImpl, phone, code }) {
  const config = aliyunSmsConfig(env);
  const templateParam = aliyunTemplateParam(env, code);
  const params = {
    Format: "JSON",
    Version: "2017-05-25",
    AccessKeyId: config.accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    Timestamp: aliyunTimestamp(),
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(),
    Action: "SendSms",
    RegionId: config.regionId,
    PhoneNumbers: aliyunPhoneNumber(phone),
    SignName: config.signName,
    TemplateCode: config.templateCode,
    TemplateParam: templateParam,
  };
  if (config.outId) params.OutId = config.outId;

  const body = aliyunSignedQuery(params, "POST", config.accessKeySecret);
  const response = await fetchImpl(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw smsProviderError(`Aliyun SMS failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (data?.Code !== "OK") {
    throw smsProviderError(`Aliyun SMS failed: ${data?.Code || "Error"} ${data?.Message || ""}`.trim());
  }
}

async function sendTencentSms({ env, fetchImpl, phone, code }) {
  const config = tencentSmsConfig(env);
  const action = "SendSms";
  const host = "sms.tencentcloudapi.com";
  const service = "sms";
  const version = "2021-01-11";
  const region = config.region;
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";
  const payload = {
    PhoneNumberSet: [phone],
    SmsSdkAppId: config.smsSdkAppId,
    SignName: config.signName,
    TemplateId: config.templateId,
    TemplateParamSet: tencentTemplateParams(env, code),
  };
  if (config.senderId) payload.SenderId = config.senderId;
  if (config.extendCode) payload.ExtendCode = config.extendCode;
  if (config.sessionContext) payload.SessionContext = config.sessionContext;

  const body = JSON.stringify(payload);
  const canonicalRequest = [
    "POST",
    "/",
    "",
    `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`,
    "content-type;host;x-tc-action",
    sha256Hex(body),
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = hmacSha256(`TC3${config.secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = hmacSha256(secretSigning, stringToSign, "hex");
  const authorization = [
    `TC3-HMAC-SHA256 Credential=${config.secretId}/${credentialScope}`,
    "SignedHeaders=content-type;host;x-tc-action",
    `Signature=${signature}`,
  ].join(", ");

  const response = await fetchImpl(`https://${host}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      Host: host,
      "X-TC-Action": action,
      "X-TC-Version": version,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Region": region,
    },
    body,
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw smsProviderError(`Tencent Cloud SMS failed: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  const apiError = data?.Response?.Error;
  if (apiError) {
    throw smsProviderError(`Tencent Cloud SMS failed: ${apiError.Code || "Error"} ${apiError.Message || ""}`.trim());
  }
  const failed = (data?.Response?.SendStatusSet || []).find(status => String(status.Code || "").toLowerCase() !== "ok");
  if (failed) {
    throw smsProviderError(`Tencent Cloud SMS failed: ${failed.Code || "Error"} ${failed.Message || ""}`.trim());
  }
}

function hasAnyTencentSmsConfig(env) {
  return [
    "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY",
    "TENCENT_SMS_SDK_APP_ID",
    "TENCENT_SMS_SIGN_NAME",
    "TENCENT_SMS_TEMPLATE_ID",
  ].some(key => env[key]);
}

function hasAnyAliyunSmsConfig(env) {
  return [
    "ALIYUN_ACCESS_KEY_ID",
    "ALIYUN_ACCESS_KEY_SECRET",
    "ALIYUN_SMS_SIGN_NAME",
    "ALIYUN_SMS_TEMPLATE_CODE",
  ].some(key => env[key]);
}

function hasCompleteAliyunSmsConfig(env) {
  return [
    "ALIYUN_ACCESS_KEY_ID",
    "ALIYUN_ACCESS_KEY_SECRET",
    "ALIYUN_SMS_SIGN_NAME",
    "ALIYUN_SMS_TEMPLATE_CODE",
  ].every(key => env[key]);
}

function hasCompleteTencentSmsConfig(env) {
  return [
    "TENCENTCLOUD_SECRET_ID",
    "TENCENTCLOUD_SECRET_KEY",
    "TENCENT_SMS_SDK_APP_ID",
    "TENCENT_SMS_SIGN_NAME",
    "TENCENT_SMS_TEMPLATE_ID",
  ].every(key => env[key]);
}

function hasCompleteTwilioConfig(env) {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_PHONE);
}

function aliyunSmsConfig(env) {
  const config = {
    accessKeyId: String(env.ALIYUN_ACCESS_KEY_ID || ""),
    accessKeySecret: String(env.ALIYUN_ACCESS_KEY_SECRET || ""),
    signName: String(env.ALIYUN_SMS_SIGN_NAME || ""),
    templateCode: String(env.ALIYUN_SMS_TEMPLATE_CODE || ""),
    regionId: String(env.ALIYUN_SMS_REGION_ID || "cn-hangzhou"),
    endpoint: String(env.ALIYUN_SMS_ENDPOINT || "https://dysmsapi.aliyuncs.com/"),
    outId: String(env.ALIYUN_SMS_OUT_ID || ""),
  };
  const missing = [];
  if (!config.accessKeyId) missing.push("ALIYUN_ACCESS_KEY_ID");
  if (!config.accessKeySecret) missing.push("ALIYUN_ACCESS_KEY_SECRET");
  if (!config.signName) missing.push("ALIYUN_SMS_SIGN_NAME");
  if (!config.templateCode) missing.push("ALIYUN_SMS_TEMPLATE_CODE");
  if (missing.length) {
    const error = new Error(`Aliyun SMS is missing: ${missing.join(", ")}`);
    error.statusCode = 503;
    throw error;
  }
  return config;
}

function tencentSmsConfig(env) {
  const config = {
    secretId: String(env.TENCENTCLOUD_SECRET_ID || ""),
    secretKey: String(env.TENCENTCLOUD_SECRET_KEY || ""),
    smsSdkAppId: String(env.TENCENT_SMS_SDK_APP_ID || ""),
    signName: String(env.TENCENT_SMS_SIGN_NAME || ""),
    templateId: String(env.TENCENT_SMS_TEMPLATE_ID || ""),
    region: String(env.TENCENT_SMS_REGION || "ap-guangzhou"),
    senderId: String(env.TENCENT_SMS_SENDER_ID || ""),
    extendCode: String(env.TENCENT_SMS_EXTEND_CODE || ""),
    sessionContext: String(env.TENCENT_SMS_SESSION_CONTEXT || ""),
  };
  const missing = [];
  if (!config.secretId) missing.push("TENCENTCLOUD_SECRET_ID");
  if (!config.secretKey) missing.push("TENCENTCLOUD_SECRET_KEY");
  if (!config.smsSdkAppId) missing.push("TENCENT_SMS_SDK_APP_ID");
  if (!config.signName) missing.push("TENCENT_SMS_SIGN_NAME");
  if (!config.templateId) missing.push("TENCENT_SMS_TEMPLATE_ID");
  if (missing.length) {
    const error = new Error(`Tencent Cloud SMS is missing: ${missing.join(", ")}`);
    error.statusCode = 503;
    throw error;
  }
  return config;
}

function aliyunTemplateParam(env, code) {
  const raw = String(env.ALIYUN_SMS_TEMPLATE_PARAM || env.ALIYUN_SMS_TEMPLATE_PARAMS || '{"code":"{code}"}')
    .replaceAll("{code}", code)
    .replaceAll("{minutes}", "10");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("TemplateParam must be an object.");
    return JSON.stringify(parsed);
  } catch (error) {
    const configError = new Error(`ALIYUN_SMS_TEMPLATE_PARAM must be valid JSON: ${error.message}`);
    configError.statusCode = 503;
    throw configError;
  }
}

function aliyunPhoneNumber(phone) {
  const mainlandChina = String(phone || "").match(/^\+86(1\d{10})$/);
  return mainlandChina ? mainlandChina[1] : String(phone || "").replace(/^\+/, "");
}

function aliyunTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function aliyunSignedQuery(params, method, accessKeySecret) {
  const canonicalizedQuery = Object.keys(params)
    .sort()
    .map(key => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(params[key])}`)
    .join("&");
  const stringToSign = [
    method,
    aliyunPercentEncode("/"),
    aliyunPercentEncode(canonicalizedQuery),
  ].join("&");
  const signature = crypto
    .createHmac("sha1", `${accessKeySecret}&`)
    .update(stringToSign)
    .digest("base64");
  return `Signature=${aliyunPercentEncode(signature)}&${canonicalizedQuery}`;
}

function aliyunPercentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

function tencentTemplateParams(env, code) {
  const raw = String(env.TENCENT_SMS_TEMPLATE_PARAMS || "{code}");
  return raw
    .split(",")
    .map(value => value.trim().replaceAll("{code}", code).replaceAll("{minutes}", "10"))
    .filter(value => value.length > 0);
}

async function readJsonResponse(response) {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function smsProviderError(message) {
  const error = new Error(message);
  error.statusCode = 502;
  return error;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function smsBody(code, purpose) {
  const label = purpose === "register" ? "register" : "verify";
  return `VibeBoard ${label} code: ${code}. It expires in 10 minutes.`;
}
