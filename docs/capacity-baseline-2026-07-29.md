# Capacity Baseline - 2026-07-29

## Environment

- Local EA production-mode process on port 5180
- JiuwenSwarm and knowledge services enabled
- MySQL pool: 10 connections, queue limit 100
- Scenario: read-only platform traffic (`/`, brand, liveness, readiness)
- Stage duration: 10 seconds each

## Result

| Concurrency | Requests | Throughput | Errors | p50 | p95 | p99 | Max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 1,303 | 130.3 req/s | 0 | 2.6 ms | 5.4 ms | 15.4 ms | 40.1 ms |
| 30 | 3,800 | 380.0 req/s | 0 | 2.7 ms | 9.3 ms | 32.8 ms | 72.5 ms |
| 50 | 6,205 | 620.5 req/s | 0 | 2.8 ms | 15.2 ms | 46.0 ms | 300.7 ms |

The 50-user read-only stage produced 12 database pool queue events and no request
errors. The queue absorbed the short burst without visible latency degradation,
so the default pool limit remains conservative until authenticated workload data
shows sustained pressure.

## Shanghai Authenticated Business Paths

The production calibration exercised Agent health summary, history, runtime
information, Skill registry, and MCP status using a 15-minute test session.

| Concurrency | Requests | Throughput | Errors | p95 | p99 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 182 | 18.2 req/s | 0 | 300.4 ms | 316.0 ms |
| 10 | 357 | 35.7 req/s | 0 | 315.0 ms | 428.1 ms |
| 20 | 468 | 46.8 req/s | 0 | 568.1 ms | 2,125.8 ms |

At the original 10-connection pool, the 20-user continuous-request stage showed
sustained pool queuing. Shanghai was tuned to 20 connections and 5 idle
connections; the same 20-user stage then completed 515 requests at 51.5 req/s
with zero errors, only two queue events, p95 640.9 ms, and p99 1,309.4 ms.
The open-source default remains 10 because smaller self-hosted databases may
have tighter connection budgets.

One sequential JiuwenSwarm chat smoke request completed successfully with HTTP
200 in 7.8 seconds. This is an end-to-end completion time, not first-token
latency.

## Interpretation

This result supports a 30-50 participant training session for normal navigation,
history browsing, settings, and staggered Agent use. It does not prove that 50
simultaneous model generations, MCP calls, or sandbox jobs are safe. Those paths
are bounded separately and should be calibrated with small, explicit samples to
avoid upstream throttling and unnecessary model cost.

Re-run with:

```bash
EA_LOAD_TEST_URL=http://127.0.0.1:5180 \
EA_LOAD_TEST_STAGE_SECONDS=10 \
pnpm load:capacity
```
