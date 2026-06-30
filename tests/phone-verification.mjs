import initSqlJs from "sql.js";
import { createAuthStore, normalizePhone } from "../src/authStore.mjs";
import { createPhoneVerificationService } from "../src/phoneVerification.mjs";
import { assert } from "./support/serverHarness.mjs";

const SQL = await initSqlJs();

await testTencentCloudSms();
await testAliyunSms();

console.log("phone verification ok");

async function testTencentCloudSms() {
const db = new SQL.Database();
const authStore = createAuthStore({ sqliteDb: db });
await authStore.initSchema();

let smsRequest = null;
const verificationService = createPhoneVerificationService({
  authStore,
  env: {
    VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
    TENCENTCLOUD_SECRET_ID: "AKIDEXAMPLE",
    TENCENTCLOUD_SECRET_KEY: "test-secret-key",
    TENCENT_SMS_SDK_APP_ID: "1400000000",
    TENCENT_SMS_SIGN_NAME: "VibeBoard",
    TENCENT_SMS_TEMPLATE_ID: "123456",
    TENCENT_SMS_TEMPLATE_PARAMS: "{code},10",
  },
  fetchImpl: async (url, options = {}) => {
    smsRequest = {
      url,
      headers: options.headers || {},
      body: JSON.parse(String(options.body || "{}")),
    };
    return new Response(JSON.stringify({
      Response: {
        SendStatusSet: [{ Code: "Ok", PhoneNumber: "+8619851622265" }],
        RequestId: "request-test",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});

assert(normalizePhone("19851622265") === "+8619851622265", "China mobile numbers should normalize to E.164");
assert(normalizePhone("+86 198-5162-2265") === "+8619851622265", "formatted China numbers should normalize");

const sent = await verificationService.sendCode({ phone: "19851622265" });
assert(sent.provider === "tencent-cloud", "Tencent Cloud should be selected when configured");
assert(sent.sent === true, "Tencent Cloud send should return sent true");
assert(!sent.dev_code, "public Tencent Cloud sends should not expose dev code");

assert(smsRequest?.url === "https://sms.tencentcloudapi.com", "Tencent Cloud endpoint should be used");
assert(smsRequest.headers.Authorization?.startsWith("TC3-HMAC-SHA256 "), "Tencent Cloud request should be TC3 signed");
assert(smsRequest.headers["X-TC-Action"] === "SendSms", "Tencent Cloud action should be SendSms");
assert(smsRequest.headers["X-TC-Version"] === "2021-01-11", "Tencent Cloud SMS API version should be set");
assert(smsRequest.body.PhoneNumberSet?.[0] === "+8619851622265", "Tencent Cloud phone should use +86 format");
assert(smsRequest.body.SmsSdkAppId === "1400000000", "Tencent Cloud SDK app ID should be sent");
assert(smsRequest.body.SignName === "VibeBoard", "Tencent Cloud sign name should be sent");
assert(smsRequest.body.TemplateId === "123456", "Tencent Cloud template ID should be sent");
assert(/^\d{6}$/.test(smsRequest.body.TemplateParamSet?.[0] || ""), "first Tencent Cloud template param should be the code");
assert(smsRequest.body.TemplateParamSet?.[1] === "10", "second Tencent Cloud template param should come from env");

const verified = await verificationService.verifyCode({
  phone: "+86 198-5162-2265",
  code: smsRequest.body.TemplateParamSet[0],
});
assert(verified.phone === "+8619851622265", "verification should use normalized phone");
}

async function testAliyunSms() {
  const db = new SQL.Database();
  const authStore = createAuthStore({ sqliteDb: db });
  await authStore.initSchema();

  let smsRequest = null;
  const verificationService = createPhoneVerificationService({
    authStore,
    env: {
      VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
      ALIYUN_ACCESS_KEY_ID: "LTAIEXAMPLE",
      ALIYUN_ACCESS_KEY_SECRET: "test-secret-key",
      ALIYUN_SMS_SIGN_NAME: "VibeBoard",
      ALIYUN_SMS_TEMPLATE_CODE: "SMS_123456789",
      ALIYUN_SMS_TEMPLATE_PARAM: '{"code":"{code}","minute":"{minutes}"}',
    },
    fetchImpl: async (url, options = {}) => {
      smsRequest = {
        url,
        headers: options.headers || {},
        body: String(options.body || ""),
        params: Object.fromEntries(new URLSearchParams(String(options.body || ""))),
      };
      return new Response(JSON.stringify({
        Code: "OK",
        Message: "OK",
        RequestId: "request-test",
        BizId: "biz-test",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const sent = await verificationService.sendCode({ phone: "19851622265" });
  assert(sent.provider === "aliyun-sms", "Aliyun SMS should be selected when configured");
  assert(sent.sent === true, "Aliyun SMS send should return sent true");
  assert(!sent.dev_code, "public Aliyun SMS sends should not expose dev code");

  assert(smsRequest?.url === "https://dysmsapi.aliyuncs.com/", "Aliyun SMS endpoint should be used");
  assert(smsRequest.headers["Content-Type"] === "application/x-www-form-urlencoded", "Aliyun SMS should use form encoding");
  assert(smsRequest.params.Signature, "Aliyun SMS request should be signed");
  assert(smsRequest.params.Action === "SendSms", "Aliyun SMS action should be SendSms");
  assert(smsRequest.params.Version === "2017-05-25", "Aliyun SMS API version should be set");
  assert(smsRequest.params.AccessKeyId === "LTAIEXAMPLE", "Aliyun access key ID should be sent");
  assert(smsRequest.params.PhoneNumbers === "19851622265", "Aliyun mainland phone should omit +86");
  assert(smsRequest.params.SignName === "VibeBoard", "Aliyun sign name should be sent");
  assert(smsRequest.params.TemplateCode === "SMS_123456789", "Aliyun template code should be sent");
  const templateParam = JSON.parse(smsRequest.params.TemplateParam);
  assert(/^\d{6}$/.test(templateParam.code || ""), "Aliyun template code variable should be generated");
  assert(templateParam.minute === "10", "Aliyun template minute variable should come from placeholder");

  const verified = await verificationService.verifyCode({
    phone: "+8619851622265",
    code: templateParam.code,
  });
  assert(verified.phone === "+8619851622265", "Aliyun verification should use normalized phone");
}
