import { createHash } from "node:crypto";
import { declaredAssetPathsFromFiles, filterDeployableFiles as filterAssetDeployableFiles } from "./assetContract.mjs";
import {
  HARDWARE_APP_CONTRACT,
  MODEL_WRITABLE_FILE_NAMES as CONTRACT_MODEL_WRITABLE_FILE_NAMES,
} from "./contracts.mjs";

export const MODEL_WRITABLE_FILE_NAMES = CONTRACT_MODEL_WRITABLE_FILE_NAMES;
export const DEPLOYABLE_FILE_NAMES = Object.freeze(["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"]);

export function calculateContractHash({ buildId = "", files = {}, contract = HARDWARE_APP_CONTRACT } = {}) {
  const generatedFileNames = Array.isArray(contract?.generatedFiles) && contract.generatedFiles.length
    ? [...contract.generatedFiles].sort()
    : [...DEPLOYABLE_FILE_NAMES].sort();
  const fileEntries = generatedFileNames
    .filter(name => name !== "manifest.json")
    .map(name => [name, normalizeFileContent(files?.[name])])
    .filter(([, content]) => content !== null);
  const payload = {
    schema: "hardware-contract-hash.v1",
    buildId: String(buildId || ""),
    generatedFiles: generatedFileNames,
    requiredRuntimeApis: Array.isArray(contract?.requiredRuntimeApis) ? [...contract.requiredRuntimeApis] : [],
    files: fileEntries,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export function isModelWritableFile(filePath) {
  return MODEL_WRITABLE_FILE_NAMES.includes(normalizeFileName(filePath));
}

export function isAgentWritableFile(filePath) {
  return isModelWritableFile(filePath);
}

export function filterDeployableFiles(files = {}, options = {}) {
  const generatedFileNames = Array.isArray(options.generatedFileNames) && options.generatedFileNames.length > 0
    ? normalizeNames(options.generatedFileNames)
    : DEPLOYABLE_FILE_NAMES;
  const allowedGenerated = new Set(generatedFileNames);
  const allowedAssets = new Set(declaredAssetPathsFromFiles(files));
  const allowedExtras = new Set(normalizeNames(options.extraAllowedFileNames));
  const filtered = filterAssetDeployableFiles(files, generatedFileNames);
  const output = {};

  for (const [name, content] of Object.entries(filtered)) {
    if (allowedGenerated.has(name) || allowedAssets.has(name) || allowedExtras.has(name)) {
      output[name] = content;
    }
  }

  return output;
}

export function validateDeployConfirmation(input = {}) {
  const nested = input && typeof input === "object"
    ? (input.confirmation && typeof input.confirmation === "object"
      ? input.confirmation
      : input.deployConfirmation && typeof input.deployConfirmation === "object"
        ? input.deployConfirmation
        : {})
    : {};
  const data = { ...(input && typeof input === "object" ? input : {}), ...nested };
  const confirmation = firstText(
    data.confirmation,
    data.confirmationText,
    data.confirmation_text,
    data.deployConfirmation,
    data.deploy_confirmation,
    data.message,
  );
  const deviceId = firstText(data.deviceId, data.device_id);
  const boundDeviceId = firstText(
    data.boundDeviceId,
    data.bound_device_id,
    data.boundDevice?.id,
    data.boundDevice?.serial,
    data.boundDevice?.deviceId,
  );
  const contractHash = firstText(data.contractHash, data.contract_hash);
  const expectedContractHash = firstText(data.expectedContractHash, data.expected_contract_hash);

  const issues = [];
  if (!isExplicitConfirmation(confirmation)) {
    issues.push(issue("DEPLOY_CONFIRMATION_MISSING", "deploy confirmation is required."));
  }
  if (!deviceId) {
    issues.push(issue("DEPLOY_DEVICE_ID_MISSING", "deviceId is required for deployment."));
  }
  if (!boundDeviceId) {
    issues.push(issue("DEPLOY_DEVICE_UNBOUND", "deployment requires a bound device."));
  } else if (deviceId && deviceId !== boundDeviceId) {
    issues.push(issue("DEPLOY_DEVICE_UNBOUND", "deployment device does not match the bound device."));
  }
  if (!contractHash) {
    issues.push(issue("DEPLOY_CONTRACT_HASH_MISSING", "contractHash is required for deployment."));
  }
  if (!expectedContractHash) {
    issues.push(issue("DEPLOY_EXPECTED_CONTRACT_HASH_MISSING", "expectedContractHash is required for deployment."));
  }
  if (contractHash && expectedContractHash && contractHash !== expectedContractHash) {
    issues.push(issue("DEPLOY_CONTRACT_HASH_MISMATCH", "deployment contract hash does not match the expected hash."));
  }

  return {
    ok: issues.length === 0,
    confirmation,
    deviceId,
    boundDeviceId,
    contractHash,
    expectedContractHash,
    issues,
  };
}

function issue(code, message) {
  return { code, message, phase: "deploy" };
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function isExplicitConfirmation(value) {
  if (value === true) return true;
  const text = String(value || "").trim().toLowerCase();
  return /^(confirm|confirmed|approve|approved|deploy|yes|ok)$/.test(text);
}

function normalizeNames(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map(normalizeFileName).filter(Boolean))];
}

function normalizeFileName(value) {
  return String(value || "").trim().replaceAll("\\", "/");
}

function normalizeFileContent(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return String(value);
}
