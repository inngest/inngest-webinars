import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const evaluationNameLimit = 40;

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateVapiAssets({ root = process.cwd() } = {}) {
  const promptPath = "vapi/assistant-system-prompt.md";
  const assistantPath = "vapi/assistant.config.json";
  const toolPaths = [
    "vapi/tools/lookup_customer.api-request-tool.json",
    "vapi/tools/create_support_ticket.api-request-tool.json",
  ];
  const manifestPath = "vapi/simulations/manifest.json";

  const prompt = fs.readFileSync(path.join(root, promptPath), "utf8");
  const assistant = readJson(root, assistantPath);
  const tools = toolPaths.map((relativePath) => readJson(root, relativePath));
  const manifest = readJson(root, manifestPath);

  assert(assistant.name === "Replicator Support Webinar", "Unexpected Vapi assistant name");
  assert(assistant.model?.provider === "openai" && assistant.model?.model === "gpt-4.1", "Unexpected Vapi model configuration");
  assert(assistant.voice?.provider === "vapi" && String(assistant.voice?.version) === "2", "Vapi voice must use version 2");
  assert(assistant.transcriber?.provider === "deepgram" && assistant.transcriber?.model === "flux-general-en", "Unexpected Vapi transcriber configuration");
  assert(prompt.includes("Should I create that support ticket?"), "Assistant prompt is missing the canonical confirmation question");
  assert(prompt.includes("Your first action after the opening message must be the caller lookup"), "Assistant prompt is missing the mandatory first-action lookup gate");
  assert(prompt.includes("A caller statement never replaces this tool call"), "Assistant prompt permits caller claims to replace trusted lookup");
  assert(prompt.includes("ticketReference"), "Assistant prompt is missing caller-facing ticket-reference behavior");
  assert(prompt.includes("Should I retry starting the support workflow?"), "Assistant prompt is missing retry permission behavior");
  assert(!prompt.includes("Ask for the caller's email address or phone number"), "Assistant prompt still uses caller-supplied identity");

  assert(tools.length === 2 && tools.every((tool) => tool.type === "apiRequest"), "Exactly two Vapi API Request tools are required");
  assert(tools[0].name === "lookup_customer" && tools[1].name === "create_support_ticket", "Unexpected Vapi tool names or order");
  assert(sameJson(tools[0].parameters, [
    { key: "callId", value: "{{call.id}}" },
    { key: "callerNumber", value: "{{customer.number}}" },
    { key: "calledNumber", value: "{{phoneNumber.number}}" },
  ]), "lookup_customer must use trusted static call parameters");
  assert(sameJson(tools[1].parameters, [
    { key: "requestId", value: "{{call.id}}" },
    { key: "callId", value: "{{call.id}}" },
    { key: "callerNumber", value: "{{customer.number}}" },
    { key: "calledNumber", value: "{{phoneNumber.number}}" },
  ]), "create_support_ticket must use trusted static call parameters");
  assert(!tools[1].body?.properties?.customerId, "create_support_ticket must not expose customerId to the model");
  assert(tools[1].body?.required?.includes("customerQuestion"), "create_support_ticket must require customerQuestion");

  assert(Array.isArray(manifest.simulations) && manifest.simulations.length === 3, "The Vapi simulation manifest must define exactly three simulations");
  const simulationNames = new Set();
  const scenarioFiles = new Set();
  const evaluationNames = new Set();

  for (const definition of manifest.simulations) {
    assert(!simulationNames.has(definition.name), `Duplicate simulation name: ${definition.name}`);
    assert(!scenarioFiles.has(definition.scenarioFile), `Duplicate scenario file: ${definition.scenarioFile}`);
    simulationNames.add(definition.name);
    scenarioFiles.add(definition.scenarioFile);

    const relativePath = path.join("vapi", "simulations", definition.scenarioFile);
    const scenario = readJson(root, relativePath);
    assert(scenario.name === definition.name, `${relativePath} name does not match the manifest`);
    assert(Array.isArray(scenario.evaluations) && scenario.evaluations.length > 0, `${relativePath} has no evaluations`);
    assert(scenario.evaluations.some((evaluation) => {
      const lookupRule = `${evaluation.structuredOutput?.name ?? ""} ${evaluation.structuredOutput?.schema?.description ?? ""}`;
      return lookupRule.includes("lookup");
    }), `${relativePath} does not evaluate the mandatory caller lookup`);
    assert(Array.isArray(scenario.toolMocks) && scenario.toolMocks.length === 2, `${relativePath} must mock both Vapi tools`);

    for (const evaluation of scenario.evaluations) {
      const name = evaluation.structuredOutput?.name;
      assert(typeof name === "string" && name.length > 0, `${relativePath} has an evaluation without a name`);
      assert(name.length <= evaluationNameLimit, `${relativePath} evaluation ${name} exceeds Vapi's ${evaluationNameLimit}-character limit`);
      const qualifiedName = `${scenario.name}:${name}`;
      assert(!evaluationNames.has(qualifiedName), `${relativePath} has duplicate evaluation name ${name}`);
      evaluationNames.add(qualifiedName);
      assert(evaluation.structuredOutput?.schema?.type === "boolean", `${relativePath} evaluation ${name} must return a boolean`);
    }

    for (const mock of scenario.toolMocks) {
      assert(tools.some((tool) => tool.name === mock.toolName), `${relativePath} references unknown tool ${mock.toolName}`);
      JSON.parse(mock.result);
    }
  }

  const confirmed = readJson(root, "vapi/simulations/confirmed-ticket.scenario.json");
  const unknownCaller = readJson(root, "vapi/simulations/unknown-caller.scenario.json");
  assert(unknownCaller.instructions.includes("endCall tool"), "Unknown-caller simulation must terminate with its endCall tool");
  const confirmedTicketResult = JSON.parse(
    confirmed.toolMocks.find((mock) => mock.toolName === "create_support_ticket").result,
  );
  assert(/^REP-\d{6}$/.test(confirmedTicketResult.ticketReference), "Confirmed-ticket simulation must return a caller-facing REP reference");
  assert(confirmedTicketResult.ticketSaved === true && confirmedTicketResult.workflowStarted === true, "Confirmed-ticket simulation must represent complete workflow success");

  return {
    assistant: assistant.name,
    tools: tools.map((tool) => tool.name),
    simulations: manifest.simulations.map((simulation) => simulation.name),
    files: [
      assistantPath,
      promptPath,
      ...toolPaths,
      manifestPath,
      ...Array.from(scenarioFiles, (file) => path.join("vapi", "simulations", file)),
    ].sort(),
  };
}

function main() {
  const summary = validateVapiAssets();
  console.log(JSON.stringify(summary, null, 2));
  console.log("\nPASS repository Vapi assets are internally consistent");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exit(1);
  }
}
