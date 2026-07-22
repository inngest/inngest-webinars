import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateVapiAssets } from "./validate-vapi-assets.mjs";

const root = process.cwd();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function cleanUrl(value) {
  return value.replace(/\/$/, "");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function hash(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 12);
}

function project(value, shape) {
  if (Array.isArray(shape)) return value;
  if (!shape || typeof shape !== "object") return value;
  return Object.fromEntries(
    Object.entries(shape).map(([key, nestedShape]) => [
      key,
      project(value?.[key], nestedShape),
    ]),
  );
}

async function getVapi(pathname) {
  const response = await fetch(`https://api.vapi.ai${pathname}`, {
    headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`GET ${pathname}: ${response.status} ${body?.message || "request failed"}`);
  }
  return body;
}

function expectedTool(relativePath, publicUrl) {
  const tool = readJson(relativePath);
  tool.credentialId = process.env.VAPI_API_CREDENTIAL_ID;
  tool.url = tool.name === "lookup_customer"
    ? `${publicUrl}/api/customers/lookup`
    : `${publicUrl}/api/tickets`;
  return tool;
}

export async function assertVapiConfigMatches({ allowDrift = false } = {}) {
  validateVapiAssets();
  for (const name of [
    "VAPI_API_KEY",
    "VAPI_ASSISTANT_ID",
    "VAPI_LOOKUP_CUSTOMER_TOOL_ID",
    "VAPI_CREATE_SUPPORT_TICKET_TOOL_ID",
    "VAPI_API_CREDENTIAL_ID",
    "PUBLIC_URL",
  ]) {
    if (!process.env[name]) throw new Error(`Missing ${name} in .env`);
  }

  const publicUrl = cleanUrl(process.env.PUBLIC_URL);
  const expectedAssistant = readJson("vapi/assistant.config.json");
  expectedAssistant.model.messages[0].content = fs.readFileSync(
    path.join(root, "vapi/assistant-system-prompt.md"),
    "utf8",
  );
  expectedAssistant.model.toolIds = [
    process.env.VAPI_LOOKUP_CUSTOMER_TOOL_ID,
    process.env.VAPI_CREATE_SUPPORT_TICKET_TOOL_ID,
  ];

  const expectedTools = [
    expectedTool("vapi/tools/lookup_customer.api-request-tool.json", publicUrl),
    expectedTool("vapi/tools/create_support_ticket.api-request-tool.json", publicUrl),
  ];
  const [liveAssistant, ...liveTools] = await Promise.all([
    getVapi(`/assistant/${process.env.VAPI_ASSISTANT_ID}`),
    getVapi(`/tool/${process.env.VAPI_LOOKUP_CUSTOMER_TOOL_ID}`),
    getVapi(`/tool/${process.env.VAPI_CREATE_SUPPORT_TICKET_TOOL_ID}`),
  ]);

  const comparisons = [
    {
      resource: "assistant",
      expected: expectedAssistant,
      live: project(liveAssistant, expectedAssistant),
    },
    ...expectedTools.map((expected, index) => ({
      resource: `tool:${expected.name}`,
      expected,
      live: project(liveTools[index], expected),
    })),
  ];
  const drift = comparisons
    .filter(({ expected, live }) => canonicalJson(expected) !== canonicalJson(live))
    .map(({ resource, expected, live }) => ({
      resource,
      expectedHash: hash(expected),
      liveHash: hash(live),
    }));

  if (drift.length > 0) {
    const summary = JSON.stringify(drift);
    if (!allowDrift) {
      throw new Error(
        `Live Vapi configuration differs from the repository: ${summary}. Run npm run deploy:vapi before simulations.`,
      );
    }
    console.warn(`WARN allowing live Vapi configuration drift: ${summary}`);
    return { matches: false, drift };
  }

  console.log("PASS live Vapi assistant and tool configuration matches the repository");
  return { matches: true, drift: [] };
}

async function main() {
  await assertVapiConfigMatches({ allowDrift: process.argv.includes("--allow-drift") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`FAIL ${error.message}`);
    process.exit(1);
  });
}
