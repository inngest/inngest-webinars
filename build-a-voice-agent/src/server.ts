import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { serve } from "inngest/express";
import { z } from "zod";
import {
  createCallSession,
  createTicket,
  deleteExpiredCallSessions,
  getCallSession,
  getCustomer,
  getCustomerByContact,
  getTicket,
  getTicketByCallId,
  getTicketByRequestId,
  seedDemoData,
  transitionTicketStatus,
  type Ticket,
} from "./db.js";
import { inngest } from "./inngest/client.js";
import { functions } from "./inngest/functions.js";
import {
  defaultCorrelationLogger,
  logCorrelation,
  type CorrelationLogger,
} from "./logging.js";

const demoMode = process.env.DEMO_MODE === "1";
const apiToken = process.env.API_BEARER_TOKEN;

if (!apiToken && !demoMode) {
  throw new Error("API_BEARER_TOKEN is required unless DEMO_MODE=1 is explicitly enabled");
}
if (demoMode && process.env.NODE_ENV === "production") {
  throw new Error("DEMO_MODE=1 cannot be used in production");
}

seedDemoData();
deleteExpiredCallSessions();

const callSessionSchema = z.object({
  callId: z.string().min(1).max(200),
  callerNumber: z.string().min(1).max(32),
  calledNumber: z.string().min(1).max(32),
}).strict();

const ticketSchema = z.object({
  callId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  callerNumber: z.string().min(1).max(32),
  calledNumber: z.string().min(1).max(32),
  customerQuestion: z.string().min(1).max(4_000),
  deviceModel: z.string().min(1).max(100).optional(),
  firmwareVersion: z.string().min(1).max(100).optional(),
  symptom: z.string().min(1).max(1_000).optional(),
  errorCode: z.string().min(1).max(100).optional(),
}).strict();

const resolutionSchema = z.object({ answer: z.string().min(1).max(4_000) }).strict();
const feedbackSchema = z.object({ helpful: z.boolean() }).strict();

type TicketInput = z.infer<typeof ticketSchema>;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function sendApiError(response: express.Response, error: unknown) {
  if (error instanceof ApiError) {
    response.locals.correlation = {
      ...response.locals.correlation,
      errorCode: error.code,
    };
    return response.status(error.status).json({ error: error.code, message: error.message, ...error.extra });
  }
  response.locals.correlation = { ...response.locals.correlation, errorCode: "internal_error" };
  return response.status(500).json({ error: "internal_error", message: "Unexpected server error" });
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, "invalid_request", "Request body does not match the API contract");
  }
  return result.data;
}

function requireApiToken(request: express.Request, response: express.Response) {
  if (!apiToken || request.get("authorization") !== `Bearer ${apiToken}`) {
    response.locals.correlation = { ...response.locals.correlation, errorCode: "unauthorized" };
    response.status(401).json({ error: "unauthorized", message: "Valid bearer authentication is required" });
    return false;
  }
  return true;
}

function publicCustomer(customer: NonNullable<ReturnType<typeof getCustomer>>) {
  return {
    name: customer.name,
    product: customer.product,
    deviceModel: customer.device_model,
    firmwareVersion: customer.firmware_version,
  };
}

function normalizeE164(value: string) {
  const normalized = value.trim().replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new ApiError(400, "invalid_request", "Phone numbers must be valid E.164 values");
  }
  return normalized;
}

function requireActiveCallSession(callId: string) {
  const session = getCallSession(callId);
  if (!session) throw new ApiError(404, "call_session_not_found", "No trusted call session was found");
  if (Date.parse(session.expires_at) <= Date.now()) {
    throw new ApiError(409, "call_session_expired", "The trusted call session has expired");
  }
  const customer = getCustomer(session.customer_id);
  if (!customer) throw new ApiError(404, "customer_not_found", "The call session has no matching customer");
  return { session, customer };
}

function registerTrustedCallSession(input: z.infer<typeof callSessionSchema>) {
  const callerNumber = normalizeE164(input.callerNumber);
  const calledNumber = normalizeE164(input.calledNumber);

  const existing = getCallSession(input.callId);
  if (existing) {
    if (existing.caller_number !== callerNumber || existing.called_number !== calledNumber) {
      throw new ApiError(409, "call_context_conflict", "callId was already registered with different trusted context");
    }
    const customer = getCustomer(existing.customer_id);
    if (!customer) throw new ApiError(404, "customer_not_found", "The call session has no matching customer");
    return { session: existing, customer, created: false };
  }

  const customer = getCustomerByContact(callerNumber);
  if (!customer) {
    throw new ApiError(404, "caller_not_found", "No customer matches the trusted caller number");
  }

  const expiresAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
  const session = createCallSession({
    callId: input.callId,
    callerNumber,
    calledNumber,
    customerId: customer.id,
    expiresAt,
  });
  return { session, customer, created: true };
}

function ticketMatches(ticket: Ticket, input: TicketInput, customerId: string) {
  return ticket.request_id === input.requestId
    && ticket.call_id === input.callId
    && ticket.customer_id === customerId
    && ticket.issue === input.customerQuestion
    && ticket.device_model === (input.deviceModel ?? null)
    && ticket.firmware_version === (input.firmwareVersion ?? null)
    && ticket.symptom === (input.symptom ?? null)
    && ticket.error_code === (input.errorCode ?? null);
}

type EventSender = (event: Parameters<typeof inngest.send>[0]) => ReturnType<typeof inngest.send>;

async function dispatchTicket(ticket: Ticket, sendEvent: EventSender, logger: CorrelationLogger) {
  if (ticket.status !== "event_pending" && ticket.status !== "event_failed") {
    return { ticket, inngestEventId: undefined };
  }
  const previousStatus = ticket.status;
  let inngestEventId: string | undefined;
  try {
    const result = await sendEvent({
      id: `support-ticket-created-${ticket.request_id}`,
      name: "support/ticket.created",
      data: { ticketId: ticket.id, requestId: ticket.request_id, callId: ticket.call_id },
      meta: { sessions: { ticket_id: ticket.id, call_id: ticket.call_id ?? "unknown" } },
    });
    inngestEventId = result.ids[0];
  } catch {
    transitionTicketStatus(ticket.id, ["event_pending", "event_failed"], "event_failed");
    logCorrelation(logger, "ticket.state_transition", {
      callId: ticket.call_id,
      requestId: ticket.request_id,
      ticketId: ticket.id,
      fromStatus: previousStatus,
      toStatus: "event_failed",
      outcome: "error",
      errorCode: "workflow_dispatch_failed",
    });
    throw new ApiError(503, "workflow_dispatch_failed", "The research workflow could not be started", {
      ok: false,
      ticketId: ticket.id,
      ticketReference: ticket.reference,
      ticketSaved: true,
      workflowStarted: false,
      status: "event_failed",
      retryable: true,
    });
  }

  transitionTicketStatus(ticket.id, ["event_pending", "event_failed"], "researching");
  const dispatched = getTicket(ticket.id)!;
  logCorrelation(logger, "ticket.state_transition", {
    callId: dispatched.call_id,
    requestId: dispatched.request_id,
    ticketId: dispatched.id,
    fromStatus: previousStatus,
    toStatus: "researching",
    outcome: "success",
    inngestEventId,
  });
  return { ticket: dispatched, inngestEventId };
}

async function createAndDispatchTicket(input: TicketInput, sendEvent: EventSender, logger: CorrelationLogger) {
  const { session, customer } = requireActiveCallSession(input.callId);
  const callerNumber = normalizeE164(input.callerNumber);
  const calledNumber = normalizeE164(input.calledNumber);
  if (session.caller_number !== callerNumber || session.called_number !== calledNumber) {
    throw new ApiError(409, "call_context_mismatch", "Trusted call context does not match the active call session");
  }
  let ticket = getTicketByRequestId(input.requestId) ?? getTicketByCallId(input.callId);
  let created = false;

  if (ticket) {
    if (!ticketMatches(ticket, input, customer.id)) {
      throw new ApiError(409, "idempotency_conflict", "requestId was already used with different ticket content");
    }
  } else {
    try {
      ticket = createTicket(
        {
          requestId: input.requestId,
          callId: input.callId,
          customerId: customer.id,
          issue: input.customerQuestion,
        },
        {
          deviceModel: input.deviceModel,
          firmwareVersion: input.firmwareVersion,
          symptom: input.symptom,
          errorCode: input.errorCode,
        },
      );
      created = true;
      logCorrelation(logger, "ticket.state_transition", {
        callId: ticket.call_id,
        requestId: ticket.request_id,
        ticketId: ticket.id,
        fromStatus: null,
        toStatus: "event_pending",
        outcome: "success",
      });
    } catch {
      ticket = getTicketByRequestId(input.requestId);
      if (!ticket || !ticketMatches(ticket, input, customer.id)) {
        throw new ApiError(409, "idempotency_conflict", "requestId was already used with different ticket content");
      }
    }
  }

  const dispatched = await dispatchTicket(ticket, sendEvent, logger);
  return { ...dispatched, created };
}

function ticketSuccessResponse(ticket: Ticket, created: boolean) {
  return {
    ok: true,
    created,
    ticketId: ticket.id,
    ticketReference: ticket.reference,
    ticketSaved: true,
    workflowStarted: !["event_pending", "event_failed"].includes(ticket.status),
    status: ticket.status,
    duplicate: !created,
    retryable: false,
  };
}

export function createApp({
  sendEvent = inngest.send.bind(inngest) as EventSender,
  logger = defaultCorrelationLogger,
}: {
  sendEvent?: EventSender;
  logger?: CorrelationLogger;
} = {}) {
  const app = express();
  app.use(express.json({ limit: "128kb" }));
  app.use((request, response, next) => {
    const startedAt = performance.now();
    response.on("finish", () => {
      logCorrelation(logger, "api.request", {
        method: request.method,
        route: request.route?.path ?? request.path,
        ...response.locals.correlation,
        outcome: response.statusCode < 400 ? "success" : "error",
        httpStatus: response.statusCode,
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
      });
    });
    next();
  });

  app.get("/health", (_request, response) => response.json({ ok: true }));

  // This is called at the beginning of a Vapi call using static, trusted call
  // fields. The backend, not model-controlled input, chooses the customer.
  app.post("/api/call-sessions", (request, response) => {
    if (!requireApiToken(request, response)) return;
    try {
      const input = parse(callSessionSchema, request.body);
      response.locals.correlation = { toolName: "lookup_customer", callId: input.callId };
      const { session, customer, created } = registerTrustedCallSession(input);
      return response.status(created ? 201 : 200).json({ callId: session.call_id, expiresAt: session.expires_at, customer: publicCustomer(customer) });
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  app.post("/api/customers/lookup", (request, response) => {
    if (!requireApiToken(request, response)) return;
    try {
      const callIdOnly = z.object({ callId: z.string().min(1).max(200) }).strict().safeParse(request.body);
      const callId = callIdOnly.success ? callIdOnly.data.callId : request.body?.callId;
      response.locals.correlation = { toolName: "lookup_customer", callId };
      const customer = callIdOnly.success
        ? requireActiveCallSession(callIdOnly.data.callId).customer
        : registerTrustedCallSession(parse(callSessionSchema, request.body)).customer;
      return response.json(publicCustomer(customer));
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  app.post("/api/tickets", async (request, response) => {
    if (!requireApiToken(request, response)) return;
    try {
      const input = parse(ticketSchema, request.body);
      response.locals.correlation = {
        toolName: "create_support_ticket",
        callId: input.callId,
        requestId: input.requestId,
      };
      const { ticket, created, inngestEventId } = await createAndDispatchTicket(input, sendEvent, logger);
      response.locals.correlation = {
        ...response.locals.correlation,
        ticketId: ticket.id,
        inngestEventId,
      };
      return response.status(created ? 201 : 200).json(ticketSuccessResponse(ticket, created));
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  // Local-only shortcut. It remains unavailable unless DEMO_MODE=1 is explicit.
  app.post("/test", async (request, response) => {
    if (!demoMode) return response.status(404).json({ error: "not_found" });
    try {
      const input = parse(ticketSchema, request.body);
      response.locals.correlation = { callId: input.callId, requestId: input.requestId };
      const { ticket, created, inngestEventId } = await createAndDispatchTicket(input, sendEvent, logger);
      response.locals.correlation = { ...response.locals.correlation, ticketId: ticket.id, inngestEventId };
      return response.status(created ? 201 : 200).json(ticketSuccessResponse(ticket, created));
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  // Kept as a compatibility adapter while Amanda owns the Vapi configuration.
  // It never accepts customer identity from tool arguments.
  app.post("/api/vapi/tools", async (request, response) => {
    if (!requireApiToken(request, response)) return;
    const calls = request.body?.message?.toolCallList;
    const trustedCallId = request.body?.message?.call?.id;
    response.locals.correlation = { callId: trustedCallId };
    if (!Array.isArray(calls) || typeof trustedCallId !== "string") {
      return response.status(400).json({ error: "invalid_vapi_payload", message: "A Vapi call ID and tool calls are required" });
    }

    const results = [];
    for (const call of calls) {
      const args = call.arguments ?? call.function?.parameters ?? {};
      try {
        if (call.name === "lookup_customer") {
          response.locals.correlation = { toolName: call.name, callId: trustedCallId };
          const { customer } = requireActiveCallSession(trustedCallId);
          results.push({ toolCallId: call.id, result: publicCustomer(customer) });
        } else if (call.name === "create_support_ticket") {
          response.locals.correlation = { toolName: call.name, callId: trustedCallId, requestId: trustedCallId };
          const { session } = requireActiveCallSession(trustedCallId);
          const input = parse(ticketSchema, {
            ...args,
            requestId: trustedCallId,
            callId: trustedCallId,
            callerNumber: session.caller_number,
            calledNumber: session.called_number,
          });
          const { ticket, created, inngestEventId } = await createAndDispatchTicket(input, sendEvent, logger);
          response.locals.correlation = {
            ...response.locals.correlation,
            ticketId: ticket.id,
            inngestEventId,
          };
          results.push({ toolCallId: call.id, result: ticketSuccessResponse(ticket, created) });
        } else {
          results.push({ toolCallId: call.id, result: { error: "unknown_tool" } });
        }
      } catch (error) {
        const apiError = error instanceof ApiError ? error : new ApiError(500, "internal_error", "Unexpected server error");
        results.push({
          toolCallId: call.id,
          result: { created: false, error: apiError.code, retryable: apiError.status === 503, ...apiError.extra },
        });
      }
    }
    return response.json({ results });
  });

  app.get("/api/tickets/:ticketId", (request, response) => {
    if (!requireApiToken(request, response)) return;
    const ticket = getTicket(request.params.ticketId);
    if (!ticket) return response.status(404).json({ error: "ticket_not_found" });
    return response.json(ticket);
  });

  app.post("/api/tickets/:ticketId/resolve", async (request, response) => {
    if (!requireApiToken(request, response)) return;
    try {
      const { answer } = parse(resolutionSchema, request.body);
      const ticket = getTicket(request.params.ticketId);
      if (!ticket) throw new ApiError(404, "ticket_not_found", "Ticket was not found");
      if (ticket.status !== "needs_human_review") {
        throw new ApiError(409, "invalid_ticket_state", "Human resolution is only allowed while a ticket needs review");
      }
      try {
        const result = await sendEvent({
          id: `support-human-resolution-${ticket.id}`,
          name: "support/human-resolution.received",
          data: { ticketId: ticket.id, requestId: ticket.request_id, callId: ticket.call_id, answer },
          meta: { sessions: { ticket_id: ticket.id, call_id: ticket.call_id ?? "unknown" } },
        });
        response.locals.correlation = {
          callId: ticket.call_id,
          requestId: ticket.request_id,
          ticketId: ticket.id,
          inngestEventId: result.ids[0],
        };
      } catch {
        throw new ApiError(503, "workflow_dispatch_failed", "The resolution event could not be sent", {
          ticketId: ticket.id,
          status: ticket.status,
          retryable: true,
        });
      }
      transitionTicketStatus(ticket.id, ["needs_human_review"], "human_resolved");
      logCorrelation(logger, "ticket.state_transition", {
        ...response.locals.correlation,
        fromStatus: "needs_human_review",
        toStatus: "human_resolved",
        outcome: "success",
      });
      return response.json({ ok: true, ticketId: ticket.id, status: "human_resolved" });
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  app.post("/api/tickets/:ticketId/feedback", async (request, response) => {
    if (!requireApiToken(request, response)) return;
    try {
      const { helpful } = parse(feedbackSchema, request.body);
      const ticket = getTicket(request.params.ticketId);
      if (!ticket) throw new ApiError(404, "ticket_not_found", "Ticket was not found");
      await sendEvent({
        id: `support-customer-feedback-${ticket.id}`,
        name: "support/customer-feedback.received",
        data: { ticketId: ticket.id, helpful },
        meta: { sessions: { ticket_id: ticket.id } },
      });
      return response.json({ ok: true });
    } catch (error) {
      return sendApiError(response, error);
    }
  });

  app.use("/api/inngest", serve({ client: inngest, functions }));
  return app;
}

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
if (process.env.VOICE_AGENT_NO_LISTEN !== "1") {
  app.listen(port, () => console.log(`Voice-agent demo listening on http://localhost:${port}`));
}
