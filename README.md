# n8n Chaos Monkey

Local resilience testing for n8n webhook workflows.

Monkey analyzes an exported workflow, mutates a known-valid webhook payload, sends controlled failure cases to an isolated workflow, correlates the resulting n8n executions, and produces Markdown and JSON findings.

It is intentionally small: Node.js 20+, no runtime dependencies, no telemetry, and no hosted service.

> **Safety:** use a local or disposable test n8n instance. A campaign executes the workflow and can trigger every side effect configured in it, including emails, messages, database writes, API usage, or other external actions.

## Try it without trusting it

Clone the repository, inspect the source, and begin with the completely offline demo:

```powershell
node .\chaos-tester.mjs analyze --workflow .\examples\demo-workflow.json
```

No installation, n8n instance, workflow credentials, webhook, or API key is required for `analyze`.

Generate the demo scenarios offline:

```powershell
node .\chaos-tester.mjs generate `
  --workflow .\examples\demo-workflow.json `
  --payload .\examples\demo-payload.json `
  --expectations .\examples\demo-expectations.json `
  --out .\scenarios.generated.json
```

The recommended trust progression is:

1. `analyze` — reads one workflow export; no network access.
2. `generate` — reads a valid payload and writes proposed mutations; no network access.
3. `run` — sends those mutations only to the webhook URL you specify.
4. `collect` / `test` — optionally reads matching execution evidence from your n8n API.

## What Monkey can access

Depending on the command and arguments you choose, Monkey can:

- read the workflow, payload, expectations, API-key, and webhook-header files you explicitly name;
- write campaign and report files to the output path you choose;
- send generated POST requests to the exact webhook URL you provide;
- call the exact n8n API base you provide to read workflow status and executions;
- execute the side effects already configured in the test workflow.

## What Monkey does not do

- No telemetry, analytics, update service, or developer-operated backend.
- No upload of workflows, payloads, credentials, traces, or reports.
- No access to n8n credential values through the workflow API.
- No workflow modification, activation, deactivation, or deletion.
- No API keys or webhook secrets accepted directly as command-line values.
- No automatic redirects; HTTP redirects fail closed.
- No non-local webhook target unless `--allow-nonlocal-target` is explicit.

These statements describe v0.1.1. The relevant network calls are directly inspectable in `chaos-tester.mjs`.

## Full campaign

Requirements:

- Node.js 20 or newer;
- an exported n8n workflow JSON containing its workflow ID, or `--workflow-id`;
- a representative valid JSON payload;
- an active copy of that workflow in a local or isolated test n8n instance;
- a temporary n8n API key able to read that workflow and its executions.

Save the n8n API key in a local text file containing only the key. Then run:

```powershell
node .\chaos-tester.mjs test `
  --workflow "C:\path\workflow.json" `
  --payload "C:\path\valid-payload.json" `
  --webhook "http://localhost:5678/webhook/my-isolated-test" `
  --api-key-file "C:\path\temporary-n8n-api-key.txt" `
  --expectations ".\expectations.json" `
  --out-dir ".\chaos-results\first-run"
```

For a webhook protected by header authentication, create a local file that is excluded from Git:

```json
{
  "name": "X-Test-Key",
  "value": "temporary-secret"
}
```

Then add:

```powershell
--webhook-header-file "C:\path\temporary-webhook-header.json"
```

The header is used in memory and is not written to campaign or report files.

## Expected behavior contract

The export reveals fields used by expressions, but not necessarily which are required or identify an event. Declare that contract explicitly:

```json
{
  "requiredFields": ["ticket_id", "customer_email", "subject", "message"],
  "identityFields": ["ticket_id"],
  "duplicateConcurrency": 10
}
```

Monkey gives each scenario a distinct string identity. Only the deliveries inside `duplicate_event` share one identity. UUID identity values remain valid UUIDs. String fields ending in `_id`, or common event/request/ticket ID names, are inferred when `identityFields` is omitted; explicit configuration is safer.

## Output and privacy

The output directory contains:

- `campaign.json` — scenario metadata and HTTP observations;
- `execution-traces.json` — execution IDs, node names, statuses, and errors;
- `report.md` — readable findings;
- `report.json` — structured verdicts, root causes, severity, and remediation.

Generated request bodies are excluded from `campaign.json` by default. Use `--include-payloads` only when you deliberately want them for debugging.

Webhook responses, node names, error messages, target URLs, and workflow names may still be sensitive. Review every artifact before sharing it. See [docs/SANITIZING.md](docs/SANITIZING.md).

Exit codes:

- `0` — command completed and no failed resilience scenarios were reported;
- `1` — configuration or runtime error;
- `2` — campaign completed with at least one failed resilience scenario.

## Scenarios in v0.1.1

- valid baseline;
- each observed input field missing;
- null value;
- incompatible type;
- unexpected extra field;
- malformed JSON;
- duplicate concurrent event.

Duplicate testing sends 10 synchronized deliveries by default. Override it with `--duplicate-concurrency N` (2–100) or in the expectations file.

Static analysis recognizes Postgres `ON CONFLICT DO NOTHING` and Redis NX/set-if-not-exists as atomic candidates. Remove Duplicates, workflow static data, and Data Tables are not treated as proof of atomicity. The concurrent dynamic result decides.

## Safety controls

- Campaigns reject `/webhook-test/` URLs because n8n registers them for one request only.
- Non-local webhook targets require `--allow-nonlocal-target`.
- Requests default to a 15-second timeout; configure with `--request-timeout-ms`.
- Redirects are never followed.
- The API key can come only from a file or `N8N_API_KEY`.
- A one-command campaign verifies that the selected workflow is active before execution.

Monkey cannot prove that an environment is safe. Inspect the workflow for side effects and use test credentials, accounts, databases, recipients, and provider quotas.

## Limitations

- Input fields are inferred primarily from expressions such as `$json.body.email`.
- External-action detection is heuristic.
- A completed external-action node is stronger evidence than merely reaching it, but it is not universal proof that a remote system committed the action.
- Business-specific safety expectations still require an expectations contract or human review.
- Dependency fault injection remains experimental and can require a test-only adapter.

## Security and license

See [SECURITY.md](SECURITY.md) for the threat model and vulnerability reporting guidance.

This release uses the [Functional Source License 1.1, Apache 2.0 Future License](LICENSE). It is source-available, not OSI open source on release; the release converts to Apache 2.0 after two years under the license terms.
# n8n-chaos-monkey
Local chaos and resilience testing for n8n webhook workflows
