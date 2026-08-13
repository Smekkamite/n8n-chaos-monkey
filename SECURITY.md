# Security and threat model

n8n Chaos Monkey is a local testing tool that intentionally sends malformed and repeated requests to workflows. Treat it as an active test harness, not a passive linter.

## Trust boundaries

Monkey trusts the operator to provide:

- a workflow export safe to inspect;
- a valid payload safe to mutate;
- an isolated webhook and n8n API base;
- temporary credentials with the minimum useful access;
- a workflow whose configured side effects are safe to execute repeatedly.

The workflow, n8n instance, webhook target, and all external services called by the workflow are outside Monkey's control.

## Network behavior

`analyze` and `generate` do not make network calls.

`run` sends POST requests only to the webhook URL supplied by the operator. `collect` reads executions only from the supplied n8n API base. `test` performs both operations and first reads the selected workflow's active state.

Redirects are refused. Requests have bounded timeouts. Non-local webhook targets require explicit opt-in. There is no telemetry or developer-operated backend.

## Credentials

- n8n API keys are accepted from a file or `N8N_API_KEY`, never as a CLI value;
- webhook header credentials are accepted from a JSON file;
- secret values are held in process memory and are not intentionally written to reports;
- workflow API responses do not expose the stored values of n8n node credentials.

Use temporary credentials and revoke or rotate them after testing. File permissions, shell history, operating-system process inspection, n8n logs, and external-service logs remain the operator's responsibility.

## Known residual risks

- A tested workflow may send real messages, emails, writes, payments, or other actions if its test copy still uses real credentials.
- Responses and error messages may contain sensitive application data.
- Node completion is not universal proof that a remote service committed an action.
- Static analysis is heuristic and can miss custom or community-node side effects.
- An operator can explicitly target a non-local host.

## Reporting a vulnerability

Until a dedicated security contact is published, open a GitHub issue containing no credentials, workflow exports, payloads, or private execution data. Ask for a private reporting channel if reproduction requires sensitive material.
