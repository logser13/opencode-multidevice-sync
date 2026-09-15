# Roadmap

## 0.1.1

- Session-directory visibility diagnostics for OpenCode Desktop.
- Compatibility build against `@opencode-ai/plugin` 1.18.31.
- No automatic mutation of OpenCode Desktop internal project state.

## Included in the 0.1.0 preview

- Source-level fixes for upstream reports #2, #3 and #4.
- Deterministic shards and content-based conflict detection.
- Whole-batch import transaction and integrity validation.
- Verified backups, guarded offline restore, doctor and isolated previews.
- Canonical/local path mapping and credential-file opt-out defaults.
- Synthetic fixtures, CLI smoke tests and cross-platform CI.

## Required before recommending broad production use

- Install the packaged fork on both real Windows devices and complete a round-trip Desktop acceptance test.
- Independent review of session schema coverage and Git conflict/recovery paths.
- Broader OpenCode version compatibility matrix and explicit schema adapters.
- More crash-injection tests, disk-full tests, large-history soak tests and plugin lifecycle tests.
- Reproducible npm registry publishing with maintainer authorization/provenance.

## Planned, not implemented or promised by 0.1.0

- Distributed machine ownership lease with expiry and safe takeover.
- A conflict viewer and explicit reconciliation commands.
- Fine-grained config-only / sessions-only sync selection.
- Session deletion tombstones and deliberate remote retention policies.
- Full workspace/path portability beyond top-level mapped fields.
- Optional encryption and stronger secret scanning.

No automatic upgrades of a user's working installation are part of CI or package installation.
