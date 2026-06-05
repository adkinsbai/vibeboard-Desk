export function orderedEndpoints(activeEndpoint, endpoints) {
  return [
    ...(activeEndpoint ? [activeEndpoint] : []),
    ...endpoints
  ].filter((endpoint, index, list) => (
    list.findIndex(item => item.host === endpoint.host && item.port === endpoint.port) === index
  ));
}

export function summarizeRemoteError(error) {
  const text = `${error?.stderr || ""}\n${error?.stdout || ""}\n${error?.message || ""}`.trim();
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const interesting = lines.find(line => /NoValidConnectionsError|Unable to connect|timed out|Authentication|Permission denied|Connection refused|Error reading SSH protocol banner|Connection closed/i.test(line));
  return interesting || lines.slice(-1)[0] || "remote command failed";
}

export function shQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function buildOpenSshArgs({
  endpoint,
  user,
  identityFile,
  knownHosts,
  remoteCommand
}) {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=20",
    "-i", identityFile,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-p", String(endpoint.port),
    `${user}@${endpoint.host}`,
    remoteCommand
  ];
}

export function execOpenSsh({
  execFile,
  endpoint,
  user,
  identityFile,
  knownHosts,
  remoteCommand,
  timeout = 30000,
  input = "",
  cwd
}) {
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", buildOpenSshArgs({
      endpoint,
      user,
      identityFile,
      knownHosts,
      remoteCommand
    }), {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        error.endpoint = endpoint;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export function passwordSshScript() {
  return String.raw`
import json
import subprocess
import sys

cfg = json.load(sys.stdin)
cmd_bytes = cfg["command"].encode("utf-8")
extra_input = cfg.get("input", "").encode("utf-8") if cfg.get("input") else b""
combined = cmd_bytes + b"\n" + extra_input if extra_input else cmd_bytes

ssh_cmd = [
    "sshpass", "-p", cfg["password"],
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=15",
    "-o", "UserKnownHostsFile=/dev/null",
    "-p", str(cfg["port"]),
    cfg["user"] + "@" + cfg["host"],
    "bash", "-s",
]
result = subprocess.run(
    ssh_cmd,
    capture_output=True,
    timeout=max(5, int(cfg["timeout"] / 1000)) + 10,
    input=combined,
)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
`;
}

export function buildPasswordSshPayload({
  endpoint,
  user,
  password,
  remoteCommand,
  timeout = 30000,
  input = ""
}) {
  return JSON.stringify({
    host: endpoint.host,
    port: Number(endpoint.port),
    user,
    password,
    command: remoteCommand,
    timeout,
    input
  });
}

export function execPasswordSsh({
  execFile,
  pythonBin,
  endpoint,
  user,
  password,
  remoteCommand,
  timeout = 30000,
  input = "",
  cwd,
  env = {}
}) {
  const payload = buildPasswordSshPayload({
    endpoint,
    user,
    password,
    remoteCommand,
    timeout,
    input
  });

  return new Promise((resolve, reject) => {
    const child = execFile(pythonBin, ["-c", passwordSshScript()], {
      cwd,
      timeout: timeout + 35000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
      env: { ...env, PYTHONIOENCODING: "utf-8" }
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(payload);
  });
}

export function buildUploadTextPayload(content) {
  return `${Buffer.from(content).toString("base64")}\n`;
}

export function buildUploadTextCommand(remotePath) {
  return [
    "set -eu",
    `tmp=${shQuote(`${remotePath}.tmp.$$`)}`,
    "base64 -d > \"$tmp\"",
    `mv "$tmp" ${shQuote(remotePath)}`
  ].join("\n");
}

export function uploadBundleScript() {
  return String.raw`
import base64
import json
import os
import sys

payload = json.load(sys.stdin)
for item in payload["files"]:
    p = item["path"]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp." + str(os.getpid())
    with open(tmp, "wb") as f:
        f.write(base64.b64decode(item["data"]))
    os.replace(tmp, p)
    if item.get("mode"):
        os.chmod(p, int(item["mode"], 8))
print("uploaded=" + str(len(payload["files"])))
`;
}

export function buildUploadBundlePayload(files) {
  return Buffer.from(JSON.stringify({ files })).toString("base64");
}

export function buildUploadBundleCommand(files) {
  const scriptB64 = Buffer.from(uploadBundleScript()).toString("base64");
  const dataB64 = buildUploadBundlePayload(files);
  return [
    `s=/tmp/vb_upload_$$.py`,
    `echo '${scriptB64}' | base64 -d > $s`,
    `echo '${dataB64}' | base64 -d | python3 $s`,
    `rm -f $s`
  ].join("; ");
}

export function buildWslSshArgs({
  endpoint,
  user,
  password,
  remoteCommand
}) {
  return [
    "sshpass", "-p", password,
    "ssh", "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=20",
    "-p", String(endpoint.port),
    `${user}@${endpoint.host}`,
    remoteCommand
  ];
}

export function execWslSsh({
  execFile,
  endpoint,
  user,
  password,
  remoteCommand,
  timeout = 30000,
  input = ""
}) {
  return new Promise((resolve, reject) => {
    const child = execFile("wsl.exe", buildWslSshArgs({
      endpoint,
      user,
      password,
      remoteCommand
    }), {
      timeout: timeout + 25000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export async function runAcrossEndpoints({
  activeEndpoint = null,
  endpoints,
  attempts,
  retryPattern,
  retryDelay = attempt => 0,
  boardLabel = "board",
  authHint = "",
  endpointLabel,
  runOnce
}) {
  let lastError;
  const ordered = orderedEndpoints(activeEndpoint, endpoints);

  for (const endpoint of ordered) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return {
          endpoint,
          result: await runOnce(endpoint, attempt)
        };
      } catch (error) {
        lastError = error;
        const text = `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`;
        if (!retryPattern.test(text) || attempt === attempts) {
          break;
        }
        const delay = retryDelay(attempt);
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }

  const tried = ordered.map(endpointLabel).join(", ");
  const error = new Error(`Unable to reach ${boardLabel}. Tried ${tried}.${authHint} Last error: ${summarizeRemoteError(lastError)}`);
  error.cause = lastError;
  error.stdout = lastError?.stdout || "";
  error.stderr = lastError?.stderr || "";
  throw error;
}
