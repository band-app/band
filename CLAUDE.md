# Band

IDE-agnostic agent orchestrator — dashboard + VS Code extension.

## Testing Strategy

This project uses **integration tests** as the primary testing approach. Do not write unit tests with mocked dependencies.

### Why Integration Tests

Unit tests with heavy mocking verify that your mocks work, not that your system works. Integration tests exercise the real system through its public interfaces — the same way a client or user would interact with it.

### Rules

- **Never modify production code to make a test pass.** No test-only branches, no exporting internals, no `NODE_ENV` checks in business logic.
- **Black-box testing only.** Test through public interfaces: HTTP endpoints, CLI commands, file system outputs.
- **Real infrastructure.** For databases use test containers, not mocks. For file-based state use temporary directories. Start real servers on random ports.
- **MSW for external boundaries.** Mock only what you don't own (third-party APIs) using MSW at the network layer.
- **Node.js built-in test runner.** Use `node:test` with `node:assert/strict`. Don't add test framework dependencies unless already present.

See `.claude/skills/integration-tests.md` for the full set of rules and examples.
