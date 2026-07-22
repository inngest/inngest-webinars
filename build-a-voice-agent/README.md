# Building a Voice Agent

A deliberately small Vapi + Inngest support-agent demo for the webinar.

Vapi matches trusted call context to a customer and creates a support ticket. That ticket emits an
Inngest event. Inngest researches the local database, sends an answer when it
finds one, or waits for a human resolution when it does not.

## What is included

- A local SQLite database with a replicator owner, firmware release, FAQ,
  known update issue, and service-history record.
- Authenticated Vapi API Request endpoints for trusted call setup, customer
  lookup, and ticket creation.
- Three Inngest functions: research, human-review wait, and mock email send.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

In a second terminal, start the Inngest Dev Server:

```bash
npm run inngest:dev
```

Open `http://localhost:8288` to inspect the functions and runs.

### Local Dev Server

Keep `INNGEST_DEV=1` in `.env`. This is the standard Inngest local-development
configuration and uses port `8288`. The `inngest:dev` command disables
auto-discovery and syncs only this project's `/api/inngest` endpoint. If port
`8288` is in use, it stops with a clear error rather than silently changing
ports.

## Environment variables

For local work, leave the Inngest Cloud keys blank and keep `INNGEST_DEV=1`.
For the recorded Cloud run, set these in the deployed app:

| Variable | Used for |
| --- | --- |
| `VAPI_API_KEY` | Provisioning/running Vapi (added in the next step) |
| `API_BEARER_TOKEN` | Required bearer token for Vapi and operator API routes |
| `INNGEST_EVENT_KEY` | Sending events to Inngest Cloud |
| `INNGEST_SIGNING_KEY` | Authenticating the deployed Inngest serve endpoint |

`DEMO_MODE=1` enables the local `/test` shortcut. It is disabled by default in
production and the app refuses to start in production if it is enabled. The
app also refuses to start without `API_BEARER_TOKEN` unless explicit local demo
mode is enabled.

For Railway, attach a persistent Volume and set
`DATABASE_PATH=/app/data/voice-agent.db`. Without persistent storage, ticket,
call-session, and human-review state are lost when the service restarts.

## Vapi tools

### Agent configuration source of truth

The repository is the source of truth for the complete Vapi assistant:

- `vapi/assistant.config.json` defines the model, first message, voice, and transcriber.
- `vapi/assistant-system-prompt.md` defines the assistant's conversation behavior.
- `vapi/tools/*.json` defines the two API Request tools and trusted static parameters.
- `vapi/simulations/*.json` defines the simulation suite, callers, mocks, and evaluations.
- `scripts/deploy-vapi.mjs` publishes those files; `scripts/check-vapi-config.mjs` detects live drift.

The normative trust boundaries, exact API payloads, subsystem ownership, and
remaining backend work are in [`BACKEND-CONTRACT.md`](./BACKEND-CONTRACT.md).
It supersedes the earlier uncommitted handoff notes.

Secrets, Vapi resource IDs, credentials, and the environment-specific public URL belong in `.env`; behavior does not. Validate the repository configuration without contacting Vapi:

```bash
npm run validate:vapi
```

Keep Amanda's two API Request tools. `lookup_customer` receives trusted static
Vapi call fields and creates or reuses the backend call session:

```json
{
  "callId": "<Vapi call ID>",
  "callerNumber": "<Vapi caller number>",
  "calledNumber": "<Vapi called number>"
}
```

The backend matches the customer from `callerNumber` and stores a short-lived
call session. The model must never provide a customer ID, email, or phone
number. The two tools use:

| Tool | Route | Model-facing input |
| --- | --- | --- |
| `lookup_customer` | `POST /api/customers/lookup` | `callId`, `callerNumber`, `calledNumber` (all static Vapi fields) |
| `create_support_ticket` | `POST /api/tickets` | `customerQuestion`, optional device details; `callId`, `requestId`, `callerNumber`, and `calledNumber` are static Vapi fields |

Every `/api/*` tool and operator route requires
`Authorization: Bearer $API_BEARER_TOKEN`. The temporary `/api/vapi/tools`
adapter is also authenticated, but is not the primary integration contract.

Vapi needs a public URL. During local work, expose this app with a tunnel.

### Provision the Vapi demo

The repository includes Amanda's Vapi assistant, API Request tools, and
simulation assets. After the local app is running:

```bash
npm run setup:auth
npm run tunnel
# In another terminal after the tunnel is available:
npm run deploy:vapi
npm run check:vapi-config
```

`setup:auth` creates a Vapi bearer credential that uses the same
`API_BEARER_TOKEN` as this app. `deploy:vapi` upserts exactly two API Request
tools and the assistant, then writes their Vapi IDs and public URL to `.env`.
The lookup tool sends `{{call.id}}`, `{{customer.number}}`, and
`{{phoneNumber.number}}` as static parameters; they are not model-generated
arguments. The ticket tool sends the same trusted call context plus
`{{call.id}}` as its idempotent `requestId`.

To provision the optional Vapi simulation suite after deploying the assistant:

```bash
npm run setup:vapi-simulations
npm run test:vapi-simulations
```

The assistant is intended for a Vapi phone call. The web-chat helper is not a
substitute for a phone call because it does not provide the trusted caller and
called-number variables used by the lookup tool.

## Test the long-running workflow

With the app and Inngest Dev Server running, establish Amanda's trusted demo
call session through the same lookup route Vapi uses:

```bash
curl -X POST http://localhost:3000/api/customers/lookup \
  -H 'Authorization: Bearer local-demo-token' \
  -H 'content-type: application/json' \
  -d '{"callId":"call_amanda_demo","callerNumber":"+15555550100","calledNumber":"+15555550999"}'
```

Then post the ticket payload. `/test` bypasses bearer authentication only when
`DEMO_MODE=1`, but it still requires the same trusted call session and ticket
contract as Vapi:

```bash
curl -X POST http://localhost:3000/test \
  -H 'content-type: application/json' \
  -d '{
    "callId": "call_amanda_demo",
    "requestId": "request_amanda_demo",
    "callerNumber": "+15555550100",
    "calledNumber": "+15555550999",
    "customerQuestion": "My replicator stopped working after the latest update.",
    "deviceModel": "XR-200",
    "firmwareVersion": "9.4.0",
    "symptom": "The thermal-safety light flashes and no item is replicated.",
    "errorCode": "THERM-94"
  }'
```

Open `http://localhost:8288` and select `research-support-ticket` to follow
the CRM, support-history, ticket-system, knowledge-base, FAQ, operations, and
firmware fan-out, followed by research analysis and delivery. The
complete API contract is in
[`openapi.yaml`](./openapi.yaml).

The Operations lookup deliberately returns one simulated `503` on the first
attempt. Inngest retries that step while preserving completed research steps,
so the trace includes a concise retry example.

Set `ENABLE_AI_METADATA=1` to preload `@inngest/otel/node` when started with
`npm run dev` or `npm run start`. With `OPENAI_API_KEY` set, the OpenAI SDK
emits the data that Inngest uses to populate the built-in AI Metadata panel on
`research-analysis`.

For a predictable local demo without an OpenAI request, set
`MOCK_AI_METADATA=1`. This creates a mock OpenTelemetry GenAI span with a
model name and token counts, so the same built-in AI Metadata panel is shown.

`@inngest/otel` currently introduces transitive `npm audit` findings. It is
disabled by default (`ENABLE_AI_METADATA=0`) and loaded only when you explicitly
set `ENABLE_AI_METADATA=1` for a controlled demo. Leave it disabled for a public
deployment until the dependency exposure is explicitly accepted or a supported
non-vulnerable release is available.

## Test the human-review branch

Create a ticket whose issue has no matching FAQ, then post a resolution after
the workflow reaches its wait step:

```bash
curl -X POST http://localhost:3000/api/tickets/TICKET_ID/resolve \
  -H 'Authorization: Bearer local-demo-token' \
  -H 'content-type: application/json' \
  -d '{"answer":"We are investigating this and will follow up."}'
```

The waiting Inngest run resumes and queues the same mock email function.
