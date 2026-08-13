# Changelog

## 0.1.1 — 2026-08-13

- Added static workflow analysis and webhook-input mutation.
- Added concurrent duplicate-event testing and n8n execution correlation.
- Added severity, grouped root causes, and remediation hints.
- Added atomic-idempotency candidate detection and unverified-control warnings.
- Isolated event identities between scenarios while preserving one shared duplicate identity.
- Distinguished reached, completed, and errored external-action nodes.
- Added request timeouts and fail-closed redirect handling.
- Added file-based webhook header authentication without report persistence.
- Excluded generated payload bodies from campaign artifacts by default.
- Added offline demo fixtures, privacy guidance, threat model, and release tests.
