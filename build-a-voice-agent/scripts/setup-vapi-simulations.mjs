import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { validateVapiAssets } from "./validate-vapi-assets.mjs";

const root = process.cwd();
const envPath = path.join(root, ".env");
const simulationsPath = path.join(root, "vapi", "simulations");

if (!process.env.VAPI_API_KEY) throw new Error("Missing VAPI_API_KEY in .env");

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
  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${pathname}: ${response.status} ${body?.message || text}`,
    );
  }
  return body;
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(simulationsPath, filename), "utf8"));
}

async function upsert(pathname, payload, existingItems) {
  const existing = existingItems.find((item) => item.name === payload.name);
  if (existing) {
    return vapi(`${pathname}/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }
  return vapi(pathname, {
    method: "POST",
    body: JSON.stringify(payload),
  });
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
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`);
}

async function main() {
  validateVapiAssets();
  const manifest = readJson("manifest.json");
  const [personalities, existingScenarios, existingSimulations, existingSuites] =
    await Promise.all([
      vapi("/eval/simulation/personality"),
      vapi("/eval/simulation/scenario"),
      vapi("/eval/simulation"),
      vapi("/eval/simulation/suite"),
    ]);

  const savedSimulations = [];
  for (const definition of manifest.simulations) {
    const personality = personalities.find(
      (item) => item.name === definition.personalityName,
    );
    if (!personality) {
      throw new Error(
        `Vapi personality ${JSON.stringify(definition.personalityName)} was not found`,
      );
    }

    const scenarioPayload = readJson(definition.scenarioFile);
    const scenario = await upsert(
      "/eval/simulation/scenario",
      scenarioPayload,
      existingScenarios,
    );
    const simulation = await upsert(
      "/eval/simulation",
      {
        name: definition.name,
        scenarioId: scenario.id,
        personalityId: personality.id,
      },
      existingSimulations,
    );
    savedSimulations.push({
      id: simulation.id,
      name: simulation.name,
      scenarioId: scenario.id,
      personality: personality.name,
    });
  }

  const suite = await upsert(
    "/eval/simulation/suite",
    {
      name: manifest.suiteName,
      simulationIds: savedSimulations.map((simulation) => simulation.id),
    },
    existingSuites,
  );

  updateEnv({ VAPI_SIMULATION_SUITE_ID: suite.id });
  console.log(JSON.stringify({ suite: { id: suite.id, name: suite.name }, simulations: savedSimulations }, null, 2));
  console.log("\nSaved VAPI_SIMULATION_SUITE_ID to .env. No simulations were run.");
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
