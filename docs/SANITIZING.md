# Sanitizing results before sharing

Break My Workflow does not upload reports. You decide what leaves your machine.

Before sharing any artifact, review it for:

- workflow names and IDs;
- webhook and n8n URLs;
- execution IDs;
- node names that reveal customers or internal systems;
- payload data and webhook responses;
- email addresses, chat IDs, account IDs, draft/message IDs, symbols, and order references;
- error messages containing file paths, stack traces, queries, or provider details.

Prefer sharing only the summary and root-cause sections of `report.md`, for example:

```text
Scenarios: 18
PASS: 13
FAIL: 4
REVIEW: 1

Root causes:
- CRITICAL · Idempotency absent
- HIGH · Input validation absent
```

Generated request bodies are excluded from `campaign.json` unless `--include-payloads` is explicit. This does not make every other field automatically safe to publish.

Never share API-key files, webhook-header files, raw n8n credential exports, `.env` files, or full execution data.
