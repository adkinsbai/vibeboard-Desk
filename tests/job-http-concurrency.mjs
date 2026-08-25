import path from "node:path";
import { promises as fs } from "node:fs";

import { assert, delay, withServer } from "./support/serverHarness.mjs";

const FINAL = new Set(["succeeded", "failed", "canceled"]);
const REQUIRED_FILES = [
  "index.html",
  "style.css",
  "app.js",
  "hardware_app.py",
  "manifest.json",
  "hardware-result.json",
];

await withServer(async ({ baseUrl }) => {
  const users = await Promise.all([0, 1].map(async index => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}${index}`;
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ phone: `+1555${suffix.slice(-7)}`, password: `http-concurrency-${index}-42` }),
    });
    const body = await response.json();
    assert(response.ok, `test user registration should succeed: ${JSON.stringify(body)}`);
    const cookie = String(response.headers.get("set-cookie") || "").split(";", 1)[0];
    assert(cookie, "test user registration should set a session cookie");
    return { cookie };
  }));
  const clients = users.map(user => ({
    json: (path, options = {}) => fetchJson(baseUrl, path, { ...options, headers: { cookie: user.cookie, ...(options.headers || {}) } }),
    text: (path, options = {}) => fetchText(baseUrl, path, { ...options, headers: { cookie: user.cookie, ...(options.headers || {}) } }),
  }));
  const conversations = await Promise.all(clients.map(client => client.json("/api/conversations", { method: "POST" })));
  const prompts = [
    "Build an embedded focus pulse dashboard with a white hardware studio theme",
    "Build an embedded reaction timer with a white hardware studio theme",
  ];

  try {
    const accepted = await Promise.all(prompts.map((prompt, index) => clients[index].json("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        conversation_id: conversations[index].id,
        client_run_id: `http-concurrency-${index}`,
        background: true,
        modelSettings: { enabled: false },
      }),
    })));
    assert(accepted.every(item => item.job?.id), "both HTTP submissions should return job ids");
    assert(accepted[0].job.id !== accepted[1].job.id, "separate requests must create separate jobs");

    const observed = [];
    let jobs = accepted.map(item => item.job);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const responses = await Promise.all(jobs.map((job, index) => clients[index].json(`/api/jobs/${encodeURIComponent(job.id)}`)));
      jobs = responses.map(response => response.job);
      observed.push(jobs.map(job => job.status));
      if (jobs.every(job => FINAL.has(job.status))) break;
      await delay(100);
    }

    assert(jobs.every(job => job.status === "succeeded"), `both jobs should succeed: ${JSON.stringify(jobs.map(job => job.error))}`);
    assert(
      observed.some(statuses => statuses.every(status => status === "running")),
      `both jobs should run concurrently: ${JSON.stringify(observed)}`,
    );

    const outputs = jobs.map(job => job.output || {});
    assert(outputs.every(output => output.buildEvidence?.ok === true), "both jobs should pass local code and render verification");
    assert(outputs[0].id !== outputs[1].id, "concurrent jobs must produce different build ids");
    assert(outputs[0].workspaceDir !== outputs[1].workspaceDir, "concurrent jobs must use different workspaces");

    for (let index = 0; index < outputs.length; index += 1) {
      const output = outputs[index];
      for (const filename of REQUIRED_FILES) {
        const content = await fs.readFile(path.join(output.workspaceDir, filename), "utf8");
        assert(content.trim(), `${filename} should exist and be non-empty for job ${jobs[index].id}`);
      }
      const hardwareResult = JSON.parse(await fs.readFile(path.join(output.workspaceDir, "hardware-result.json"), "utf8"));
      assert(hardwareResult.build_id === output.id, "hardware result must belong to its own build");
      assert(hardwareResult.available_apis?.includes("./hardware-result.json"), "hardware result must expose its runtime contract");

      const conversationFiles = await clients[index].json(`/api/conversations/${conversations[index].id}/files`);
      assert(conversationFiles.buildId === output.id, "conversation snapshot must keep its own build id");
      assert(conversationFiles.files?.["hardware-result.json"], "conversation snapshot must retain hardware-result.json");
      const preview = await clients[index].text(`/api/conversations/${conversations[index].id}/preview/index.html`);
      assert(preview.includes(output.id), "conversation preview must render its own build");
      assert(!preview.includes(outputs[1 - index].id), "conversation preview must not contain the other build id");
    }

    const deployAccepted = await Promise.all(outputs.map((output, index) => clients[index].json("/api/deploy", {
      method: "POST",
      body: JSON.stringify({
        background: true,
        build_id: output.id,
        conversation_id: conversations[index].id,
      }),
    })));
    const deployJobs = await Promise.all(deployAccepted.map(async (accepted, index) => {
      assert(accepted.job?.id, `deploy ${index} should return a job id`);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const response = await clients[index].json(`/api/jobs/${encodeURIComponent(accepted.job.id)}`);
        if (FINAL.has(response.job?.status)) return response.job;
        await delay(100);
      }
      throw new Error(`deploy ${index} did not finish`);
    }));
    assert(deployJobs.every(job => job.status === "succeeded"), `bound deploy jobs should succeed: ${JSON.stringify(deployJobs)}`);
    assert(deployJobs.every((job, index) => job.output?.id === outputs[index].id), "deploy must use the requested build id");
  } finally {
    await Promise.all(conversations.map((conversation, index) => (
      clients[index].json(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: "DELETE" }).catch(() => null)
    )));
  }
});

console.log("HTTP job concurrency and embedded artifact isolation ok");

async function fetchJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { "content-type": "application/json", accept: "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.text();
  const data = body ? JSON.parse(body) : null;
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function fetchText(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  return body;
}
