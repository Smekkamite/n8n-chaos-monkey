# Changelog

## 0.1.3 — 2026-08-22

- Prevented malformed JSON scenarios from passing after reaching an external side effect.
- Added strict bounds for execution collection options.
- Added cursor pagination so campaigns can collect more than 100 executions.
- Added regression tests and a full campaign test against a fake n8n API.
- Added cross-platform setup examples and updated GitHub Actions.

## 0.1.2

- Renamed the project to Break My Workflow.
- Renamed the package, executable, main script, reports, and default output directory.

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
