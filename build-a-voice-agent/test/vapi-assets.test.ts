import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("defines only the two Vapi API Request tools", () => {
  const lookup = read("vapi/tools/lookup_customer.api-request-tool.json");
  const ticket = read("vapi/tools/create_support_ticket.api-request-tool.json");
  assert.equal(lookup.type, "apiRequest");
  assert.equal(ticket.type, "apiRequest");
  assert.equal(lookup.name, "lookup_customer");
  assert.equal(ticket.name, "create_support_ticket");
});

test("keeps customer identity in Vapi static call parameters", () => {
  const lookup = read("vapi/tools/lookup_customer.api-request-tool.json");
  const ticket = read("vapi/tools/create_support_ticket.api-request-tool.json");
  assert.deepEqual(lookup.parameters, [
    { key: "callId", value: "{{call.id}}" },
    { key: "callerNumber", value: "{{customer.number}}" },
    { key: "calledNumber", value: "{{phoneNumber.number}}" },
  ]);
  assert.deepEqual(ticket.parameters, [
    { key: "requestId", value: "{{call.id}}" },
    { key: "callId", value: "{{call.id}}" },
    { key: "callerNumber", value: "{{customer.number}}" },
    { key: "calledNumber", value: "{{phoneNumber.number}}" },
  ]);
  assert.equal(lookup.body, undefined);
  assert.equal(ticket.body.properties.customerId, undefined);
  assert.equal(ticket.body.properties.customerQuestion !== undefined, true);
});

test("keeps the canonical assistant behavior and deployable simulations in code", () => {
  const validation = spawnSync(process.execPath, ["scripts/validate-vapi-assets.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /PASS repository Vapi assets are internally consistent/);

  const prompt = readFileSync("vapi/assistant-system-prompt.md", "utf8");
  assert.match(prompt, /ticketReference/);
  assert.match(prompt, /Your first action after the opening message must be the caller lookup/);
  assert.match(prompt, /A caller statement never replaces this tool call/);
  assert.match(prompt, /Should I retry starting the support workflow\?/);
  assert.doesNotMatch(prompt, /Ask for the caller's email address or phone number/);
});
