# n8n Chaos Monkey

A small local tool that tries to break n8n webhook workflows.

You give it:

- an exported n8n workflow;
- one valid webhook payload;
- the URL of an active test copy of the workflow.

It changes the payload, sends duplicate requests, looks at the resulting n8n executions, and writes a report.

The question it tries to answer is:

> My workflow works normally, but what happens when the input is wrong or the same event arrives ten times?

## What it tests

The current version checks:

- a normal valid request;
- missing fields;
- null values;
- wrong value types;
- unexpected fields;
- malformed JSON;
- concurrent duplicate events.

It also looks for nodes that call external services or create side effects, such as email drafts, messages, and database or spreadsheet writes.

This is an early version. Detection is heuristic and some results need human review.

## A real result

I originally built this for one of my own workflows.

Monkey sent the same event 10 times concurrently. All 10 executions wrote to Google Sheets and 6 created Gmail drafts before OpenAI rate limiting stopped the others.

The workflow looked fine during normal testing, but it did not have atomic idempotency protection.

A sanitized report is available in [examples/real-report-sanitized.md](examples/real-report-sanitized.md).

## Try it offline

Requirements: Node.js 20 or newer. There are no runtime dependencies.

Clone the repository and run:

```powershell
node .\chaos-tester.mjs analyze --workflow .\examples\demo-workflow.json
```

This only reads the included fake workflow. It does not connect to n8n or make network requests.

You can also inspect the generated test cases:

```powershell
node .\chaos-tester.mjs generate `
  --workflow .\examples\demo-workflow.json `
  --payload .\examples\demo-payload.json `
  --expectations .\examples\demo-expectations.json `
  --out .\scenarios.generated.json
```

## Test a workflow

Use a local or isolated n8n instance and a copy of the workflow. A campaign really executes the workflow, so real credentials can still send real emails, messages, or writes.

Save a temporary n8n API key in a text file, then run:

```powershell
node .\chaos-tester.mjs test `
  --workflow "C:\path\workflow.json" `
  --payload "C:\path\valid-payload.json" `
  --webhook "http://localhost:5678/webhook/my-test-workflow" `
  --api-key-file "C:\path\temporary-n8n-api-key.txt" `
  --expectations ".\expectations.json" `
  --out-dir ".\chaos-results\first-run"
```

The API key is used to read the matching n8n executions. It is not written to the report.

For a webhook protected by a custom header, add:

```powershell
--webhook-header-file "C:\path\webhook-header.json"
```

The file format is:

```json
{
  "name": "X-Test-Key",
  "value": "temporary-secret"
}
```

## Expectations

Monkey can see which fields a workflow reads, but it cannot always know which fields your workflow considers mandatory.

An expectations file makes that explicit:

```json
{
  "requiredFields": ["ticket_id", "customer_email", "subject", "message"],
  "identityFields": ["ticket_id"],
  "duplicateConcurrency": 10
}
```

`identityFields` is important: every scenario gets a different event ID, while the requests inside the duplicate test share the same ID.

## Output

A full campaign produces:

- `campaign.json` — HTTP results and scenario metadata;
- `execution-traces.json` — executions and nodes reached;
- `report.md` — readable results;
- `report.json` — the same results as structured data.

Payload bodies are not stored unless `--include-payloads` is used.

Reports may still contain workflow names, node names, URLs, execution IDs, responses, and error messages. Read them before sharing them. See [docs/SANITIZING.md](docs/SANITIZING.md).

## Safety limits

- Non-local webhook targets are blocked unless `--allow-nonlocal-target` is provided.
- Redirects are not followed.
- Requests have a timeout.
- Monkey does not modify or activate workflows.
- There is no telemetry or hosted backend.

These limits do not make a production workflow safe to test. Use a test copy and test credentials.

## Current limitations

- Input detection mostly relies on expressions such as `$json.body.email`.
- Side-effect detection is based on node type and operation.
- A completed node does not always prove that a remote service committed the action.
- Business-specific behavior still needs a human expectation.
- Dependency faults such as 429, 500, and timeouts are still experimental.

## Commands

The main command is `test`. The individual stages are also available:

```text
analyze → generate → run → collect → report
```

Run `node chaos-tester.mjs --help` for the available options.

## License

v0.1.1 is released under the [Functional Source License 1.1, Apache 2.0 Future License](LICENSE).
