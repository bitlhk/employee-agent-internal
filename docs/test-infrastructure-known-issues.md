# Test Infrastructure Known Issues

## Vitest worker RPC timeout in the full suite

- **Status:** Open / test infrastructure only
- **Observed:** 2026-08-24
- **Scope:** Long-running full Vitest suite with concurrent workers
- **Symptom:** Vite worker RPC fetch timeouts can appear after all executed business assertions pass.
- **Functional evidence:** The affected files pass when run independently; focused WP2 verification passes 20/20 and database integration passes 13/13.
- **Quality impact:** Does not change the frozen Context Quality baseline or the `Work Continuity Proven` business status.
- **Current handling:** Treat RPC timeout as an infrastructure failure, keep focused suites as release evidence, and do not suppress failed business assertions.
- **Follow-up:** Isolate worker lifecycle/resource exhaustion, then restore a clean full-suite infrastructure result without relaxing test thresholds.
