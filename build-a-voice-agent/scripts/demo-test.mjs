import "dotenv/config";

const baseUrl = (process.env.DEMO_BASE_URL || process.env.PUBLIC_URL || "http://127.0.0.1:3000")
  .replace(/\/$/, "");
const authorization = process.env.API_BEARER_TOKEN
  ? { Authorization: `Bearer ${process.env.API_BEARER_TOKEN}` }
  : {};
const headers = {
  "content-type": "application/json",
  "ngrok-skip-browser-warning": "1",
  ...authorization,
};

const callContext = {
  callId: `call_demo_${crypto.randomUUID()}`,
  callerNumber: "+15555550100",
  calledNumber: "+15555550999",
};

async function json(response, step) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${step} failed with ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForTicketStatus(ticketId, expectedStatus, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const ticket = await json(await fetch(`${baseUrl}/api/tickets/${ticketId}`, { headers }), "ticket status");
    lastStatus = ticket.status;
    if (lastStatus === expectedStatus) return ticket;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`ticket ${ticketId} did not reach ${expectedStatus}; last status was ${lastStatus}`);
}

async function main() {
  const ticketRequestId = callContext.callId;
  await json(await fetch(`${baseUrl}/health`, { headers }), "health check");
  console.log("PASS health");

  const unauthenticatedLookup = await fetch(`${baseUrl}/api/customers/lookup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(callContext),
  });
  if (unauthenticatedLookup.status !== 401 || (await unauthenticatedLookup.json()).error !== "unauthorized") {
    throw new Error("unauthenticated customer lookup was not rejected");
  }
  console.log("PASS unauthenticated customer lookup rejected (401)");

  const unauthenticatedTicket = await fetch(`${baseUrl}/api/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callId: callContext.callId, requestId: ticketRequestId, customerQuestion: "This request must be rejected." }),
  });
  if (unauthenticatedTicket.status !== 401 || (await unauthenticatedTicket.json()).error !== "unauthorized") {
    throw new Error("unauthenticated ticket creation was not rejected");
  }
  console.log("PASS unauthenticated ticket creation rejected (401)");

  const customer = await json(await fetch(`${baseUrl}/api/customers/lookup`, {
    method: "POST", headers, body: JSON.stringify(callContext),
  }), "customer lookup");
  if (customer.name !== "Amanda Martin" || customer.deviceModel !== "XR-200" || "customerId" in customer) {
    throw new Error(`customer lookup returned an unexpected contract: ${JSON.stringify(customer)}`);
  }
  console.log("PASS trusted caller lookup");

  const unknown = await fetch(`${baseUrl}/api/customers/lookup`, {
    method: "POST", headers,
    body: JSON.stringify({ ...callContext, callId: `call_unknown_${crypto.randomUUID()}`, callerNumber: "+15555559999" }),
  });
  if (unknown.status !== 404 || (await unknown.json()).error !== "caller_not_found") {
    throw new Error("unknown trusted caller did not return the expected safe error");
  }
  console.log("PASS unknown caller rejected without disclosing account data");

  const ticketBody = {
    callId: callContext.callId,
    requestId: ticketRequestId,
    callerNumber: callContext.callerNumber,
    calledNumber: callContext.calledNumber,
    customerQuestion: "My replicator stopped working after the 9.4.0 update.",
    symptom: "The thermal-safety light flashes.",
    errorCode: "THERM-94",
  };
  const creation = await json(await fetch(`${baseUrl}/api/tickets`, {
    method: "POST", headers, body: JSON.stringify(ticketBody),
  }), "ticket creation");
  if (
    !creation.ticketId ||
    !/^REP-\d{6}$/.test(creation.ticketReference) ||
    creation.status !== "researching" ||
    creation.created !== true ||
    creation.ticketSaved !== true ||
    creation.workflowStarted !== true
  ) {
    throw new Error(`ticket creation returned an unexpected contract: ${JSON.stringify(creation)}`);
  }
  console.log(`PASS ticket creation (${creation.ticketId})`);

  const duplicateResponse = await fetch(`${baseUrl}/api/tickets`, {
    method: "POST", headers, body: JSON.stringify(ticketBody),
  });
  const duplicate = await json(duplicateResponse, "duplicate ticket creation");
  if (
    duplicateResponse.status !== 200 ||
    duplicate.ticketId !== creation.ticketId ||
    duplicate.ticketReference !== creation.ticketReference ||
    duplicate.created !== false ||
    duplicate.duplicate !== true
  ) {
    throw new Error(`duplicate request was not safely reused: ${JSON.stringify(duplicate)}`);
  }
  console.log("PASS duplicate call request reused its ticket");

  const conflicting = await fetch(`${baseUrl}/api/tickets`, {
    method: "POST", headers,
    body: JSON.stringify({ ...ticketBody, customerQuestion: "A different issue must not reuse this call." }),
  });
  if (conflicting.status !== 409 || (await conflicting.json()).error !== "idempotency_conflict") {
    throw new Error("conflicting request was not rejected");
  }
  console.log("PASS conflicting request rejected (409)");

  await waitForTicketStatus(creation.ticketId, "answered");
  console.log("PASS known issue completed the research and delivery workflow");

  const humanCallContext = {
    ...callContext,
    callId: `call_human_${crypto.randomUUID()}`,
  };
  await json(await fetch(`${baseUrl}/api/customers/lookup`, {
    method: "POST",
    headers,
    body: JSON.stringify(humanCallContext),
  }), "human-review caller lookup");
  const humanTicket = await json(await fetch(`${baseUrl}/api/tickets`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...humanCallContext,
      requestId: humanCallContext.callId,
      customerQuestion: "Where is my replacement delivery?",
    }),
  }), "human-review ticket creation");
  await waitForTicketStatus(humanTicket.ticketId, "needs_human_review");
  console.log("PASS unrelated issue reached human review");
  await json(await fetch(`${baseUrl}/api/tickets/${humanTicket.ticketId}/resolve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ answer: "A technician will follow up with the delivery status." }),
  }), "human resolution");
  await waitForTicketStatus(humanTicket.ticketId, "answered");
  console.log("PASS human resolution resumed and completed delivery");
  console.log("\nDemo test passed. It validates authentication, trusted call context, idempotency, and both workflow branches.");
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
