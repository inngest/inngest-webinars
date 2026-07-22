import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after, before } from "node:test";
import Database from "better-sqlite3";

const testDirectory = mkdtempSync(join(tmpdir(), "voice-agent-test-"));
process.env.DATABASE_PATH = join(testDirectory, "voice-agent.db");
process.env.DEMO_MODE = "1";
process.env.API_BEARER_TOKEN = "test-token";
process.env.VOICE_AGENT_NO_LISTEN = "1";
process.env.INNGEST_DEV = "1";

const { createApp } = await import("../src/server.js");
const {
  createCallSession,
  createTicket,
  db,
  deleteExpiredCallSessions,
  getCallSession,
  getKnowledgeBaseArticles,
  getTicket,
  recordEmail,
  updateTicketStatus,
} = await import("../src/db.js");
const { researchSupportTicket } = await import("../src/inngest/functions.js");

const sentEvents: Array<Record<string, unknown>> = [];
const structuredLogs: Array<Record<string, unknown>> = [];
let failDispatch = false;
const app = createApp({
  sendEvent: async (event) => {
    if (failDispatch) throw new Error("simulated dispatch failure");
    sentEvents.push(event as Record<string, unknown>);
    return { ids: ["event_test"] } as never;
  },
  logger: (record) => structuredLogs.push(record),
});

let baseUrl = "";
let server: ReturnType<typeof app.listen>;
const bearer = { authorization: "Bearer test-token" };

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

async function createAmandaCall(callId = "call_amanda") {
  const response = await request("/api/call-sessions", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ callId, callerNumber: "+15555550100", calledNumber: "+15555550999" }),
  });
  assert.equal(response.status, 201);
}

const ticketPayload = (overrides: Record<string, unknown> = {}) => ({
  callId: "call_amanda",
  requestId: "request_amanda_1",
  callerNumber: "+15555550100",
  calledNumber: "+15555550999",
  customerQuestion: "My replicator stopped working after the latest update.",
  deviceModel: "XR-200",
  firmwareVersion: "9.4.0",
  symptom: "The thermal-safety light flashes and no item is replicated.",
  errorCode: "THERM-94",
  ...overrides,
});

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
  db.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

test("clean startup seeds Amanda without a foreign-key violation", () => {
  const customer = db.prepare("SELECT id FROM customers WHERE id = 'cus_amanda'").get();
  const history = db.prepare("SELECT customer_id FROM service_history WHERE id = 'service_amanda_filter'").get() as { customer_id: string };
  assert.deepEqual(customer, { id: "cus_amanda" });
  assert.equal(history.customer_id, "cus_amanda");
});

test("startup preserves and reopens the exact c9e10c1 database schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-legacy-"));
  const databasePath = join(directory, "legacy.db");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL UNIQUE,
      product TEXT NOT NULL,
      device_model TEXT NOT NULL,
      firmware_version TEXT NOT NULL,
      warranty_status TEXT NOT NULL
    );
    CREATE TABLE knowledge (
      id TEXT PRIMARY KEY,
      product TEXT NOT NULL,
      keywords TEXT NOT NULL,
      answer TEXT NOT NULL
    );
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      issue TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      device_model TEXT,
      firmware_version TEXT,
      symptom TEXT,
      error_code TEXT,
      answer TEXT,
      idempotency_key TEXT,
      reference TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
    CREATE TABLE outbound_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
    );
    INSERT INTO customers (
      id, name, email, phone, product, device_model, firmware_version, warranty_status
    ) VALUES (
      'cus_amanda', 'Amanda Martin', 'amanda.martin@example.com', '+15555550100',
      'Home Replicator', 'XR-200', '9.4.0', 'active'
    );
    INSERT INTO support_tickets (
      id, customer_id, issue, status, created_at, device_model, firmware_version,
      symptom, error_code, idempotency_key, reference
    ) VALUES (
      'ticket_c9', 'cus_amanda', 'Historical ticket', 'answered',
      '2026-07-20T12:00:00.000Z', 'XR-200', '9.4.0', 'Thermal light', 'THERM-94',
      'request_c9', 'REP-000777'
    );
  `);
  legacy.close();

  runServerMigration(databasePath);
  runServerMigration(databasePath);

  const migrated = new Database(databasePath);
  const customerColumns = migrated.prepare("PRAGMA table_info(customers)").all() as Array<{ name: string }>;
  assert.equal(customerColumns.some((column) => column.name === "device_model"), true);
  assert.equal(customerColumns.some((column) => column.name === "replicator_model"), false);
  const ticketColumns = migrated.prepare("PRAGMA table_info(support_tickets)").all() as Array<{ name: string }>;
  assert.equal(ticketColumns.some((column) => column.name === "request_id"), true);
  const historicalTicket = migrated.prepare("SELECT reference FROM support_tickets WHERE id = 'ticket_c9'").get();
  assert.deepEqual(historicalTicket, { reference: "REP-000777" });
  migrated.close();
  rmSync(directory, { recursive: true, force: true });
});

test("startup canonically migrates main's competing replicator_model column", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-main-schema-"));
  const databasePath = join(directory, "main.db");
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL UNIQUE,
      product TEXT NOT NULL,
      replicator_model TEXT,
      firmware_version TEXT,
      warranty_status TEXT
    );
    INSERT INTO customers (
      id, name, email, phone, product, replicator_model, firmware_version, warranty_status
    ) VALUES (
      'cus_amanda', 'Amanda Martin', 'amanda.martin@example.com', '+15555550100',
      'Home Replicator', 'XR-200', '9.4.0', 'active'
    );
  `);
  database.close();

  runServerMigration(databasePath);
  runServerMigration(databasePath);

  const migrated = new Database(databasePath);
  const columns = migrated.prepare("PRAGMA table_info(customers)").all() as Array<{ name: string; notnull: number }>;
  assert.equal(columns.some((column) => column.name === "replicator_model"), false);
  assert.equal(columns.find((column) => column.name === "device_model")?.notnull, 1);
  const customer = migrated.prepare("SELECT device_model FROM customers WHERE id = 'cus_amanda'").get();
  assert.deepEqual(customer, { device_model: "XR-200" });
  migrated.close();
  rmSync(directory, { recursive: true, force: true });
});

test("startup fails without an API bearer token outside explicit demo mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-agent-auth-"));
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: join(directory, "voice-agent.db"),
      API_BEARER_TOKEN: "",
      DEMO_MODE: "",
      VOICE_AGENT_NO_LISTEN: "1",
      INNGEST_DEV: "1",
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /API_BEARER_TOKEN is required/);
  rmSync(directory, { recursive: true, force: true });
});

test("private routes fail closed", async () => {
  const customerResponse = await request("/api/customers/lookup", { method: "POST", body: "{}" });
  const ticketResponse = await request("/api/tickets/not-a-ticket");
  const vapiResponse = await request("/api/vapi/tools", { method: "POST", body: "{}" });
  assert.equal(customerResponse.status, 401);
  assert.equal(ticketResponse.status, 401);
  assert.equal(vapiResponse.status, 401);
});

test("trusted call state derives customer ownership and returns minimum fields", async () => {
  const unknown = await request("/api/call-sessions", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ callId: "call_unknown", callerNumber: "+15550000000", calledNumber: "+15555550999" }),
  });
  assert.equal(unknown.status, 404);

  const lookup = await request("/api/customers/lookup", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ callId: "call_amanda", callerNumber: "+15555550100", calledNumber: "+15555550999" }),
  });
  assert.equal(lookup.status, 200);
  const customer = await lookup.json() as Record<string, unknown>;
  assert.equal(customer.name, "Amanda Martin");
  assert.equal("customerId" in customer, false);
  assert.equal("email" in customer, false);
  assert.equal("phone" in customer, false);
  assert.equal("warrantyStatus" in customer, false);

  const callerConflict = await request("/api/customers/lookup", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ callId: "call_amanda", callerNumber: "+15555559999", calledNumber: "+15555550999" }),
  });
  assert.equal(callerConflict.status, 409);
  assert.equal((await callerConflict.json() as { error: string }).error, "call_context_conflict");

  const calledNumberConflict = await request("/api/customers/lookup", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ callId: "call_amanda", callerNumber: "+15555550100", calledNumber: "+15555558888" }),
  });
  assert.equal(calledNumberConflict.status, 409);
  assert.equal((await calledNumberConflict.json() as { error: string }).error, "call_context_conflict");
});

test("trusted phone context is normalized to E.164 and invalid values create no session", async () => {
  const normalized = await request("/api/customers/lookup", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({
      callId: "call_formatted",
      callerNumber: "+1 (555) 555-0100",
      calledNumber: "+1 (555) 555-0999",
    }),
  });
  assert.equal(normalized.status, 200);
  assert.equal(getCallSession("call_formatted")?.caller_number, "+15555550100");
  assert.equal(getCallSession("call_formatted")?.called_number, "+15555550999");

  const ticket = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(ticketPayload({
      callId: "call_formatted",
      requestId: "request_formatted",
      callerNumber: "+1 555 555 0100",
      calledNumber: "+1-555-555-0999",
    })),
  });
  assert.equal(ticket.status, 201);

  const invalid = await request("/api/customers/lookup", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ callId: "call_invalid_phone", callerNumber: "555-0100", calledNumber: "+15555550999" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { error: string }).error, "invalid_request");
  assert.equal(getCallSession("call_invalid_phone"), undefined);
});

test("expired call-session cleanup removes only expired state", () => {
  createCallSession({
    callId: "call_expired_cleanup",
    customerId: "cus_amanda",
    callerNumber: "+15555550100",
    calledNumber: "+15555550999",
    expiresAt: "2026-01-01T00:00:00.000Z",
  });
  createCallSession({
    callId: "call_active_cleanup",
    customerId: "cus_amanda",
    callerNumber: "+15555550100",
    calledNumber: "+15555550999",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(deleteExpiredCallSessions("2026-07-22T00:00:00.000Z"), 1);
  assert.equal(getCallSession("call_expired_cleanup"), undefined);
  assert.notEqual(getCallSession("call_active_cleanup"), undefined);
});

test("ticket requests require trusted call context and cannot accept model-provided customer ownership", async () => {
  const invalid = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ ...ticketPayload(), customerId: "cus_someone_else" }),
  });
  assert.equal(invalid.status, 400);

  const mismatchedContext = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(ticketPayload({ callerNumber: "+15555559999" })),
  });
  assert.equal(mismatchedContext.status, 409);
  assert.equal((await mismatchedContext.json() as { error: string }).error, "call_context_mismatch");

  const first = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(ticketPayload()),
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json() as {
    ok: boolean;
    ticketId: string;
    ticketReference: string;
    ticketSaved: boolean;
    workflowStarted: boolean;
    status: string;
  };
  assert.equal(firstBody.ok, true);
  assert.match(firstBody.ticketReference, /^REP-\d{6}$/);
  assert.equal(firstBody.ticketSaved, true);
  assert.equal(firstBody.workflowStarted, true);
  assert.equal(firstBody.status, "researching");
  assert.equal(structuredLogs.some((record) =>
    record.event === "ticket.state_transition"
      && record.callId === "call_amanda"
      && record.requestId === "request_amanda_1"
      && record.ticketId === firstBody.ticketId
      && record.toStatus === "researching"
      && record.inngestEventId === "event_test"
  ), true);
  assert.equal(structuredLogs.some((record) =>
    record.event === "api.request"
      && record.toolName === "create_support_ticket"
      && record.callId === "call_amanda"
      && record.requestId === "request_amanda_1"
      && record.ticketId === firstBody.ticketId
      && record.httpStatus === 201
  ), true);

  const duplicate = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(ticketPayload()),
  });
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json() as { ticketId: string; ticketReference: string; duplicate: boolean };
  assert.equal(duplicateBody.ticketId, firstBody.ticketId);
  assert.equal(duplicateBody.ticketReference, firstBody.ticketReference);
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(sentEvents.filter(
    (event) => event.name === "support/ticket.created"
      && (event.data as { requestId?: string } | undefined)?.requestId === "request_amanda_1",
  ).length, 1);

  const conflict = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(ticketPayload({ customerQuestion: "A different question" })),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: string }).error, "idempotency_conflict");

  const secondRequestForCall = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(ticketPayload({ requestId: "request_amanda_2" })),
  });
  assert.equal(secondRequestForCall.status, 409);
});

test("failed dispatch is visible and an identical retry resumes the existing ticket", async () => {
  await createAmandaCall("call_retry");
  failDispatch = true;
  const payload = ticketPayload({ callId: "call_retry", requestId: "request_retry" });
  const failed = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(failed.status, 503);
  const failedBody = await failed.json() as {
    ok: boolean;
    ticketId: string;
    ticketReference: string;
    ticketSaved: boolean;
    workflowStarted: boolean;
    status: string;
    retryable: boolean;
  };
  assert.equal(failedBody.ok, false);
  assert.match(failedBody.ticketReference, /^REP-\d{6}$/);
  assert.equal(failedBody.ticketSaved, true);
  assert.equal(failedBody.workflowStarted, false);
  assert.equal(failedBody.status, "event_failed");
  assert.equal(failedBody.retryable, true);

  failDispatch = false;
  const retried = await request("/api/tickets", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(retried.status, 200);
  const retriedBody = await retried.json() as { ticketId: string; ticketReference: string; status: string; workflowStarted: boolean };
  assert.equal(retriedBody.ticketId, failedBody.ticketId);
  assert.equal(retriedBody.ticketReference, failedBody.ticketReference);
  assert.equal(retriedBody.workflowStarted, true);
  assert.equal(retriedBody.status, "researching");
});

test("Vapi compatibility adapter derives ticket identity from trusted call state", async () => {
  await createAmandaCall("call_adapter");
  const response = await request("/api/vapi/tools", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        call: { id: "call_adapter" },
        toolCallList: [
          {
            id: "tool_adapter_ticket",
            name: "create_support_ticket",
            arguments: {
              requestId: "model_supplied_request_id",
              callId: "model_supplied_call_id",
              callerNumber: "+15555559999",
              calledNumber: "+15555558888",
              customerQuestion: "My replicator stopped working after the latest update.",
            },
          },
        ],
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    results: Array<{ toolCallId: string; result: { ok: boolean; ticketId: string; ticketReference: string } }>;
  };
  assert.equal(body.results[0]?.toolCallId, "tool_adapter_ticket");
  assert.equal(body.results[0]?.result.ok, true);
  assert.match(body.results[0]?.result.ticketReference, /^REP-\d{6}$/);

  const ticket = getTicket(body.results[0]!.result.ticketId);
  assert.equal(ticket?.request_id, "call_adapter");
  assert.equal(ticket?.call_id, "call_adapter");
  assert.equal(ticket?.customer_id, "cus_amanda");
});

test("unrelated questions do not receive the thermal-safety knowledge-base answer", () => {
  assert.deepEqual(getKnowledgeBaseArticles("XR-200", "9.4.0", "Where can I find a replacement delivery?"), []);
  assert.equal(getKnowledgeBaseArticles("XR-200", "9.4.0", "The latest update left thermal safety on.").length, 1);
});

test("research workflow queues an answer for a known issue and human review for an unrelated issue", async () => {
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "";

  const runResearch = async (issue: string) => {
    const ticket = createTicket({
      requestId: `workflow_${crypto.randomUUID()}`,
      callId: `call_workflow_${crypto.randomUUID()}`,
      customerId: "cus_amanda",
      issue,
    }, { deviceModel: "XR-200", firmwareVersion: "9.4.0" });
    updateTicketStatus(ticket.id, "researching");
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const step = {
      run: async (_id: string, fn: () => unknown) => fn(),
      sendEvent: async (_id: string, event: { name: string; data: Record<string, unknown> }) => {
        events.push(event);
      },
      score: async () => undefined,
    };
    const fn = (researchSupportTicket as unknown as {
      fn: (tools: Record<string, unknown>) => Promise<unknown>;
    }).fn;
    await fn({
      event: { data: { ticketId: ticket.id, requestId: ticket.request_id, callId: ticket.call_id } },
      step,
      attempt: 1,
      defer: () => undefined,
      demoDelay: async () => undefined,
    });
    return { ticket, events };
  };

  try {
    const known = await runResearch("My replicator stopped working after the 9.4.0 update and thermal safety is flashing.");
    assert.equal(getTicket(known.ticket.id)?.status, "reply_queued");
    assert.equal(known.events[0]?.name, "support/reply.ready");

    const unrelated = await runResearch("Where is my replacement delivery?");
    assert.equal(getTicket(unrelated.ticket.id)?.status, "needs_human_review");
    assert.equal(unrelated.events[0]?.name, "support/escalation.requested");
  } finally {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
});

test("human resolution is state-checked and outbound delivery is idempotent", async () => {
  const ticket = getTicketByRequestIdForTest("request_amanda_1");
  updateTicketStatus(ticket.id, "needs_human_review");
  const resolve = await request(`/api/tickets/${ticket.id}/resolve`, {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ answer: "A technician will follow up." }),
  });
  assert.equal(resolve.status, 200);
  assert.equal(getTicket(ticket.id)?.status, "human_resolved");

  const repeated = await request(`/api/tickets/${ticket.id}/resolve`, {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ answer: "A technician will follow up." }),
  });
  assert.equal(repeated.status, 409);

  updateTicketStatus(ticket.id, "reply_queued");
  recordEmail(ticket.id, "amanda.martin@example.com", "Hello");
  recordEmail(ticket.id, "amanda.martin@example.com", "Hello");
  const messageCount = db.prepare("SELECT COUNT(*) AS count FROM outbound_messages WHERE ticket_id = ?").get(ticket.id) as { count: number };
  assert.equal(messageCount.count, 1);
  assert.equal(getTicket(ticket.id)?.status, "answered");
});

function getTicketByRequestIdForTest(requestId: string) {
  const ticket = db.prepare("SELECT * FROM support_tickets WHERE request_id = ?").get(requestId) as ReturnType<typeof getTicket>;
  if (!ticket) throw new Error(`Expected ticket for ${requestId}`);
  return ticket;
}

function runServerMigration(databasePath: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      DEMO_MODE: "1",
      VOICE_AGENT_NO_LISTEN: "1",
      INNGEST_DEV: "1",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}
