import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { validateVapiAssets } from "./validate-vapi-assets.mjs";

const root = process.cwd();
const envPath = path.join(root, ".env");

function cleanUrl(value) {
  return value.replace(/\/$/, "");
}

async function discoverPublicUrl() {
  if (process.env.PUBLIC_URL) return cleanUrl(process.env.PUBLIC_URL);
  if (process.env.NGROK_DOMAIN) {
    return `https://${process.env.NGROK_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  }
  const response = await fetch("http://127.0.0.1:4040/api/tunnels");
  if (!response.ok) throw new Error("Set PUBLIC_URL or start ngrok with npm run tunnel");
  const body = await response.json();
  const tunnel = body.tunnels?.find((item) => item.proto === "https") || body.tunnels?.[0];
  if (!tunnel?.public_url) throw new Error("No active ngrok tunnel found");
  return cleanUrl(tunnel.public_url);
}

async function vapi(pathname, options = {}) {
  const response = await fetch(`https://api.vapi.ai${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname}: ${response.status} ${body?.message || text}`);
  return body;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function withoutType(payload) {
  const { type: _type, ...rest } = payload;
  return rest;
}

async function upsertTool({ template, idVariable, publicUrl, existingTools }) {
  const payload = readJson(template);
  payload.credentialId = process.env.VAPI_API_CREDENTIAL_ID;
  payload.url = payload.name === "lookup_customer"
    ? `${publicUrl}/api/customers/lookup`
    : `${publicUrl}/api/tickets`;
  const configuredId = process.env[idVariable];
  const existing = existingTools.find((tool) => tool.id === configuredId) ||
    existingTools.find((tool) => tool.type === "apiRequest" && tool.name === payload.name);
  return existing
    ? vapi(`/tool/${existing.id}`, { method: "PATCH", body: JSON.stringify(withoutType(payload)) })
    : vapi("/tool", { method: "POST", body: JSON.stringify(payload) });
}

function updateEnv(values) {
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const keys = new Set(Object.keys(values));
  const seen = new Set();
  const lines = current.split(/\r?\n/).filter(Boolean).map((line) => {
    const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
    if (!key || !keys.has(key)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`);
}

async function main() {
  validateVapiAssets();
  if (!process.env.VAPI_API_KEY) throw new Error("Missing VAPI_API_KEY in .env");
  if (!process.env.VAPI_API_CREDENTIAL_ID) {
    throw new Error("Missing VAPI_API_CREDENTIAL_ID; run npm run setup:auth first");
  }
  const publicUrl = await discoverPublicUrl();
  const existingTools = await vapi("/tool");
  const lookup = await upsertTool({
    template: "vapi/tools/lookup_customer.api-request-tool.json",
    idVariable: "VAPI_LOOKUP_CUSTOMER_TOOL_ID",
    publicUrl,
    existingTools,
  });
  const createTicket = await upsertTool({
    template: "vapi/tools/create_support_ticket.api-request-tool.json",
    idVariable: "VAPI_CREATE_SUPPORT_TICKET_TOOL_ID",
    publicUrl,
    existingTools,
  });

  const assistant = readJson("vapi/assistant.config.json");
  assistant.model.messages[0].content = fs.readFileSync(path.join(root, "vapi/assistant-system-prompt.md"), "utf8");
  assistant.model.toolIds = [lookup.id, createTicket.id];
  const assistants = await vapi("/assistant");
  const existingAssistant = assistants.find((item) => item.id === process.env.VAPI_ASSISTANT_ID) ||
    assistants.find((item) => item.name === assistant.name);
  const savedAssistant = existingAssistant
    ? await vapi(`/assistant/${existingAssistant.id}`, { method: "PATCH", body: JSON.stringify(assistant) })
    : await vapi("/assistant", { method: "POST", body: JSON.stringify(assistant) });

  updateEnv({
    PUBLIC_URL: publicUrl,
    VAPI_LOOKUP_CUSTOMER_TOOL_ID: lookup.id,
    VAPI_CREATE_SUPPORT_TICKET_TOOL_ID: createTicket.id,
    VAPI_ASSISTANT_ID: savedAssistant.id,
  });
  console.log(JSON.stringify({ publicUrl, tools: [lookup.id, createTicket.id], assistantId: savedAssistant.id }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
