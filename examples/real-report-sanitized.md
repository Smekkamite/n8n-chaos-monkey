# Sanitized real-world finding

This excerpt comes from an owner-controlled non-production workflow. Names, IDs, URLs, payloads, and execution details were removed.

## Concurrent duplicate delivery

**Result: FAIL**

- 10 identical events were delivered concurrently.
- 10 executions completed a Google Sheets append node.
- 6 executions completed a Gmail draft-creation node.
- 4 stopped later because an AI provider rate-limited them.

### CRITICAL · Idempotency absent

Duplicate deliveries created duplicate external actions. A visual duplicate-removal control was not atomic across concurrent n8n executions.

**Remediation:** claim the event key atomically in durable storage before every external action, then return a duplicate/no-op outcome for all losing executions.
