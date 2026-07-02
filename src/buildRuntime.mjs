import path from "node:path";
import { promises as fs } from "node:fs";
import {
  buildCompileManifest,
  readGeneratedFiles,
  withAssetVersion,
} from "./buildArtifact.mjs";
import {
  HARDWARE_APP_CONTRACT,
  HARDWARE_RESULT_FILE,
  assertFileContracts,
  validateHardwareResultContract,
} from "./contracts.mjs";
import {
  AGENT_PHASES,
  appendEvidence,
} from "./agentStateMachine.mjs";
import { createBuildIntelligenceSummary } from "./buildIntelligence.mjs";
import {
  executePythonRunner,
  isPythonRunnerTransportError,
  pythonRunnerRequired,
} from "./pythonRunnerClient.mjs";

export function createBuildRuntime(deps = {}) {
  const {
    appendServerLog = async () => {},
    execFileP,
    verifyAllLocal,
    createAppSpec,
    generatedManifest,
    injectAppHardwareSdkContracts = (source) => source,
    injectHardwareAppContracts = (source) => source,
    getCurrentBuild,
    getBoard = () => ({}),
    pythonBin,
    nodeBin = process.execPath,
    env = process.env,
  } = deps;

  requireFunction(execFileP, "execFileP");
  requireFunction(verifyAllLocal, "verifyAllLocal");
  requireFunction(createAppSpec, "createAppSpec");
  requireFunction(generatedManifest, "generatedManifest");
  requireFunction(getCurrentBuild, "getCurrentBuild");
  requireString(pythonBin, "pythonBin");

  async function buildCurrent() {
    const currentBuild = getCurrentBuild();
    if (!currentBuild) throw new Error("No generated app. Generate first.");

    await appendServerLog("build.start", { id: currentBuild.id });

    const appFile = path.join(currentBuild.dir, "app.js");
    const hardwareFile = path.join(currentBuild.dir, "hardware_app.py");
    const hardwareResultFile = path.join(currentBuild.dir, HARDWARE_RESULT_FILE);
    const indexFile = path.join(currentBuild.dir, "index.html");
    const styleFile = path.join(currentBuild.dir, "style.css");
    const manifestFile = path.join(currentBuild.dir, "manifest.json");

    currentBuild.files ||= {};

    try {
      const appSource = await fs.readFile(appFile, "utf8");
      const contractedApp = injectAppHardwareSdkContracts(appSource, currentBuild.id);
      if (contractedApp !== appSource) {
        await fs.writeFile(appFile, contractedApp, "utf8");
        currentBuild.files["app.js"] = contractedApp;
      }
    } catch {}

    try {
      const hardwareSource = await fs.readFile(hardwareFile, "utf8");
      const contractedHardware = injectHardwareAppContracts(hardwareSource, currentBuild.id);
      if (contractedHardware !== hardwareSource) {
        await fs.writeFile(hardwareFile, contractedHardware, "utf8");
        currentBuild.files["hardware_app.py"] = contractedHardware;
      }
    } catch {}

    try {
      const indexSource = await fs.readFile(indexFile, "utf8");
      const versionedIndex = withAssetVersion(indexSource, currentBuild.id);
      if (versionedIndex !== indexSource) {
        await fs.writeFile(indexFile, versionedIndex, "utf8");
        currentBuild.files["index.html"] = versionedIndex;
      }
    } catch {}

    await execFileP(nodeBin, ["--check", appFile], { timeout: 10000 });
    const filesForRunner = await readGeneratedFiles(currentBuild.dir, HARDWARE_APP_CONTRACT.generatedFiles);
    const hardwareCompile = await runPythonCheck({
      files: filesForRunner,
      mode: "compile",
      entry: "hardware_app.py",
      pythonBin,
      execFileP,
      args: ["-m", "py_compile", hardwareFile],
      cwd: currentBuild.dir,
      timeout: 10000,
      env,
    });
    const hardwareRun = await runPythonCheck({
      files: filesForRunner,
      mode: "run",
      entry: "hardware_app.py",
      pythonBin,
      execFileP,
      args: [hardwareFile],
      cwd: currentBuild.dir,
      timeout: 10000,
      env,
    });

    const hardwareResult = parseJsonObject(hardwareRun.stdout, "hardware_app.py output");
    const hardwareIssues = validateHardwareResultContract(hardwareResult, {
      label: "hardware_app.py output",
      expectedBuildId: currentBuild.id,
    });
    if (hardwareIssues.length) {
      const detail = hardwareIssues.map(issue => `${issue.code}: ${issue.message}`).join("; ");
      throw new Error(detail);
    }

    const hardwareResultJson = JSON.stringify(hardwareResult, null, 2);
    await fs.writeFile(hardwareResultFile, hardwareResultJson, "utf8");
    delete currentBuild.files[HARDWARE_RESULT_FILE];

    for (const file of [indexFile, styleFile, appFile, hardwareFile, manifestFile]) {
      const stat = await fs.stat(file);
      if (!stat.size) throw new Error(`${path.basename(file)} is empty`);
    }
    const hardwareResultStat = await fs.stat(hardwareResultFile);
    if (!hardwareResultStat.size) throw new Error(`${HARDWARE_RESULT_FILE} is empty`);

    assertFileContracts(
      await readGeneratedFiles(currentBuild.dir, HARDWARE_APP_CONTRACT.generatedFiles),
      "Generated app",
    );

    let previousManifest = {};
    try {
      previousManifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    } catch {
      previousManifest = {};
    }

    const spec = createAppSpec(currentBuild.prompt, currentBuild.id);
    const manifest = buildCompileManifest({
      generatedManifest: generatedManifest(currentBuild.prompt, currentBuild.id, spec),
      previousManifest,
      pythonBin,
      hardwareCompileOutput: hardwareCompile,
      targetStatic: getBoard().targetStatic,
    });
    const manifestJson = JSON.stringify(manifest, null, 2);
    await fs.writeFile(manifestFile, manifestJson, "utf8");
    currentBuild.files["manifest.json"] = manifestJson;
    currentBuild.manifest = manifest;

    const verificationFiles = {
      ...await readGeneratedFiles(currentBuild.dir, HARDWARE_APP_CONTRACT.generatedFiles),
      [HARDWARE_RESULT_FILE]: hardwareResultJson,
    };
    const verification = await verifyAllLocal(verificationFiles, {
      dir: currentBuild.dir,
      pythonBin,
      timeoutMs: 15000,
      pythonRunnerUrl: env.PYTHON_RUNNER_URL,
      pythonRunnerToken: env.PYTHON_RUNNER_TOKEN,
      pythonRunnerRequired: env.PYTHON_RUNNER_REQUIRED,
      pythonRunnerTimeoutMs: env.PYTHON_RUNNER_TIMEOUT_MS,
    });
    if (!verification.ok) {
      await appendServerLog("build.failed", {
        id: currentBuild.id,
        issues: (verification.issues || []).map(issue => ({ code: issue.code, message: issue.message })),
      });
      const detail = (verification.issues || [])
        .slice(0, 5)
        .map(issue => `${issue.code}: ${issue.message}`)
        .join("; ");
      const error = new Error(`local verification failed: ${detail || verification.summary}`);
      error.verification = verification;
      throw error;
    }

    currentBuild.built = true;
    currentBuild.buildEvidence = verification;
    currentBuild.buildEvidence.phase = AGENT_PHASES.LOCAL_VERIFY;
    currentBuild.buildEvidence.summary = "L0-L3 local verification passed";
    currentBuild.buildEvidence.evidence = {
      ...currentBuild.buildEvidence.evidence,
      nodeCheck: "passed",
      pythonCompile: "passed",
      hardwareRun: "passed",
      hardwareResult: `${HARDWARE_APP_CONTRACT.generatedWorkspaceDir}/${HARDWARE_RESULT_FILE}`,
      buildId: currentBuild.id,
      pythonBin,
    };
    currentBuild.intelligenceSummary = createBuildIntelligenceSummary({
      build: currentBuild,
      manifest,
      verification: currentBuild.buildEvidence,
      hardwareResult,
      board: getBoard(),
      pythonBin,
    });
    if (currentBuild.agentRun) {
      currentBuild.agentRun = appendEvidence(currentBuild.agentRun, currentBuild.buildEvidence);
    }
    await appendServerLog("build.done", {
      id: currentBuild.id,
      phase: currentBuild.buildEvidence.phase,
      issueCount: currentBuild.buildEvidence.issues?.length || 0,
      confidence: currentBuild.intelligenceSummary.confidence,
      nextBestAction: currentBuild.intelligenceSummary.nextBestAction,
    });
    return manifest;
  }

  return { buildCurrent };
}

async function runPythonCheck({
  files,
  mode,
  entry,
  pythonBin,
  execFileP,
  args,
  cwd,
  timeout,
  env,
} = {}) {
  const runnerResult = await executePythonRunner(files, {
    mode,
    entry,
    timeoutMs: timeout,
    pythonRunnerUrl: env.PYTHON_RUNNER_URL,
    pythonRunnerToken: env.PYTHON_RUNNER_TOKEN,
    pythonRunnerRequired: env.PYTHON_RUNNER_REQUIRED,
    pythonRunnerTimeoutMs: env.PYTHON_RUNNER_TIMEOUT_MS,
  });
  if (runnerResult && (!isPythonRunnerTransportError(runnerResult) || pythonRunnerRequired({
    pythonRunnerUrl: env.PYTHON_RUNNER_URL,
    pythonRunnerToken: env.PYTHON_RUNNER_TOKEN,
    pythonRunnerRequired: env.PYTHON_RUNNER_REQUIRED,
  }))) {
    if (!runnerResult.ok) {
      const error = new Error(runnerResult.message || runnerResult.stderr || `Python runner ${mode} failed.`);
      error.stdout = runnerResult.stdout;
      error.stderr = runnerResult.stderr;
      error.statusCode = runnerResult.statusCode || 500;
      throw error;
    }
    return runnerResult;
  }
  return await execFileP(pythonBin, args, { cwd, timeout });
}

export function parseJsonObject(text, label = "JSON") {
  const raw = String(text || "").trim();
  if (!raw) throw new Error(`${label} is empty.`);
  try {
    return JSON.parse(raw);
  } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(raw.slice(start, end + 1));
  }
  throw new Error(`${label} is not valid JSON.`);
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} must be a function.`);
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
}
