import "dotenv/config";
import { assertVapiConfigMatches } from "./check-vapi-config.mjs";
import { validateVapiAssets } from "./validate-vapi-assets.mjs";

const args = process.argv.slice(2);
const voice = args.includes("--voice");
const noWait = args.includes("--no-wait");
const allowDrift = args.includes("--allow-drift");
const iterationsArgument = args.find((argument) => argument.startsWith("--iterations="));
const iterations = Number(iterationsArgument?.split("=")[1] ?? 1);
const pollIntervalMs = 5_000;
const timeoutMs = Number(process.env.VAPI_SIMULATION_TIMEOUT_MS ?? 10 * 60_000);

for (const name of ["VAPI_API_KEY", "VAPI_ASSISTANT_ID", "VAPI_SIMULATION_SUITE_ID"]) {
  if (!process.env[name]) throw new Error(`Missing ${name} in .env`);
}
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10) {
  throw new Error("--iterations must be an integer from 1 to 10");
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
  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${pathname}: ${response.status} ${body?.message || text}`,
    );
  }
  return body;
}

const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

function printSummary(run) {
  console.log(JSON.stringify({
    runId: run.id,
    status: run.status,
    transport: run.transport?.provider,
    itemCounts: run.itemCounts,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  }, null, 2));
}

async function main() {
  validateVapiAssets();
  await assertVapiConfigMatches({ allowDrift });
  const transport = voice ? "vapi.websocket" : "vapi.webchat";
  console.log(`Starting ${iterations} iteration(s) in ${voice ? "voice" : "chat"} mode.`);
  if (voice) console.log("Voice mode uses two concurrent call slots per simulation and incurs audio costs.");

  const run = await vapi("/eval/simulation/run", {
    method: "POST",
    body: JSON.stringify({
      simulations: [
        {
          type: "simulationSuite",
          simulationSuiteId: process.env.VAPI_SIMULATION_SUITE_ID,
        },
      ],
      target: {
        type: "assistant",
        assistantId: process.env.VAPI_ASSISTANT_ID,
      },
      transport: { provider: transport },
      iterations,
    }),
  });

  console.log(`Simulation run queued: ${run.id}`);
  if (noWait) return;

  const deadline = Date.now() + timeoutMs;
  let completed = run;
  while (completed.status !== "ended") {
    if (Date.now() >= deadline) {
      throw new Error(`Simulation run ${run.id} did not end within ${timeoutMs}ms`);
    }
    await wait(pollIntervalMs);
    completed = await vapi(`/eval/simulation/run/${run.id}`);
  }

  printSummary(completed);
  const items = await vapi(`/eval/simulation/run/${run.id}/item`);
  for (const item of items) {
    console.log(JSON.stringify({
      simulationId: item.simulationId,
      status: item.status,
      endedReason: item.endedReason,
      evaluations: item.evaluations || item.results,
    }, null, 2));
  }

  const counts = completed.itemCounts;
  const passed = counts && counts.total > 0 && counts.passed === counts.total;
  if (!passed) throw new Error(`Simulation run ${run.id} did not pass every item`);
  console.log("\nPASS all Vapi simulations passed.");
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
