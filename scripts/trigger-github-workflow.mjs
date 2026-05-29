#!/usr/bin/env node

const REPO = process.env.GITHUB_REPOSITORY || "xb-Bogger/DailyBrief";
const WORKFLOW = process.env.GITHUB_WORKFLOW_FILE || "daily.yml";
const REF = process.env.GITHUB_WORKFLOW_REF || "main";
const TOKEN =
  process.env.CODEX_GITHUB_PERSONAL_ACCESS_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN;
const DRY_RUN = process.argv.includes("--dry-run");

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "DailyBriefLocalTrigger/1.0",
};

if (TOKEN) {
  headers.Authorization = `Bearer ${TOKEN}`;
}

function beijingDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function request(path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { res, body };
}

async function reportExists(today) {
  const path = `/contents/${today}/${today}.html?ref=gh-pages`;
  const { res } = await request(path);
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`report existence check failed: HTTP ${res.status}`);
}

async function hasActiveRun() {
  for (const status of ["queued", "in_progress"]) {
    const path = `/actions/workflows/${encodeURIComponent(
      WORKFLOW,
    )}/runs?branch=${encodeURIComponent(REF)}&status=${status}&per_page=20`;
    const { res, body } = await request(path);
    if (!res.ok) {
      throw new Error(`run check failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    }
    const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    if (runs.length > 0) return true;
  }
  return false;
}

async function dispatchWorkflow() {
  const path = `/actions/workflows/${encodeURIComponent(WORKFLOW)}/dispatches`;
  const { res, body } = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: REF }),
  });
  if (res.status !== 204) {
    throw new Error(`workflow dispatch failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
}

async function main() {
  if (!TOKEN) {
    throw new Error(
      "missing CODEX_GITHUB_PERSONAL_ACCESS_TOKEN, GITHUB_TOKEN, or GH_TOKEN",
    );
  }

  const today = beijingDateKey();
  log(`checking ${REPO} ${WORKFLOW} on ${REF}; Beijing date ${today}`);

  if (await reportExists(today)) {
    log("skip: today's report already exists on gh-pages");
    return;
  }

  if (await hasActiveRun()) {
    log("skip: workflow already has a queued or in-progress run");
    return;
  }

  if (DRY_RUN) {
    log("dry-run: would dispatch workflow now");
    return;
  }

  await dispatchWorkflow();
  log("dispatched workflow_dispatch successfully");
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] ${err.message}`);
  process.exitCode = 1;
});
