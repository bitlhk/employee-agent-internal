# Capacity Baseline - 2026-07-30

## Environment

- Local EA production-mode process on port 5180
- JiuwenSwarm and knowledge services enabled
- MySQL pool: 10 connections, queue limit 100
- Smooth weighted scheduling across each scenario
- Platform stage duration: 15 seconds each
- Authenticated multi-identity business stage duration: 10 seconds each

## Read-only Platform Result

Scenario mix: built application 60%, branding 15%, readiness 15%, and liveness
10%.

| Concurrency | Requests | Throughput | Errors | p50 | p95 | p99 | Max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 1,936 | 129.07 req/s | 0 | 2.7 ms | 6.1 ms | 11.9 ms | 56.9 ms |
| 30 | 5,655 | 377.00 req/s | 0 | 2.6 ms | 8.6 ms | 33.0 ms | 278.7 ms |
| 50 | 9,606 | 640.40 req/s | 0 | 2.8 ms | 11.6 ms | 35.8 ms | 51.7 ms |

All stages passed the platform acceptance gate of less than 1% errors and p95
below one second.

## Authenticated Business Result

Scenario mix: history 30%, Skill registry 20%, MCP status 20%, file capabilities
10%, channel capabilities 10%, and knowledge search 10%. Five independent
authenticated Agent identities were rotated across the workers.

| Concurrency | Requests | Throughput | Errors | Overall p95 | MCP p95 | Knowledge p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 756 | 75.6 req/s | 0 | 162.5 ms | 175.4 ms | 223.7 ms |
| 30 | 1,658 | 165.8 req/s | 0 | 242.7 ms | 210.0 ms | 324.7 ms |
| 50 | 1,776 | 177.6 req/s | 0 | 480.8 ms | 506.2 ms | 557.5 ms |

All 4,190 requests passed with no HTTP or transport errors. Every stage remained
below the A-level 1.5-second p95 gate. MCP response caching recorded 782 hits, 25
coalesced concurrent requests, and 30 misses during the run.

## Real Runtime Smoke

| Path | Result | Timing |
| --- | --- | --- |
| JiuwenSwarm + wealth MCP | HTTP 200, SSE complete, real tool event | first byte 2.54 s; first tool event 6.70 s; complete 47.22 s |
| JiuwenSwarm + focused MCP probe | HTTP 200, SSE complete, Prometheus lifecycle recorded | first byte 1.96 s; first tool event 6.55 s; complete 21.95 s |
| JiuwenBox sandbox | HTTP 200, expected output marker | 0.39 s |
| Two-account JiuwenSwarm smoke | 2/2 HTTP 200 and SSE complete | 7.84-9.71 s complete |
| Two-account JiuwenBox smoke | 2/2 HTTP 200 with expected marker | 0.31-0.34 s |

The focused MCP probe produced `ea_mcp_calls_total{kind="platform",
outcome="success"} 1`, a 10.489-second MCP duration, and zero active MCP calls
after completion.

Earlier Shanghai figures used the previous weighted scheduler and remain
directional only. They are not used for the current acceptance decision.

## Interpretation

This result supports a 30-50 participant training session for normal navigation,
history browsing, settings, and staggered Agent use. It does not prove 50
simultaneous model generations, MCP calls, or sandbox jobs. Those paths remain
bounded separately; model concurrency should be increased only with an upstream
quota and cost-controlled test.

Re-run with:

```bash
EA_LOAD_TEST_URL=http://127.0.0.1:5180 \
EA_LOAD_TEST_STAGE_SECONDS=15 \
pnpm load:capacity
```

Authenticated business calibration additionally requires a short-lived test
session and an owned test Agent:

```bash
EA_BUSINESS_LOAD_TEST_URL=http://127.0.0.1:5180 \
EA_BUSINESS_LOAD_TEST_PROFILE_FILE='<mode-0600 multi-identity JSON file>' \
EA_BUSINESS_LOAD_TEST_STAGES=10,30,50 \
EA_BUSINESS_LOAD_TEST_STAGE_SECONDS=10 \
EA_BUSINESS_LOAD_TEST_MAX_P95_MS=1500 \
pnpm load:business
```
