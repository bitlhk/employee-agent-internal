# Enterprise Operability Baseline

## Scope

This baseline adds operational visibility and recoverability without changing public APIs, database schemas, runtime selection, or user workflows.

The application audit ledger remains the source of truth for security and compliance events. Application logs and metrics are operational signals and must not duplicate sensitive audit payloads.

## Request Context

Every HTTP request receives a correlation ID before security and rate-limit middleware runs.

- Accept `x-request-id` or `x-correlation-id` only when it is 8-128 safe ASCII characters.
- Generate a UUID for missing or invalid values.
- Return the value through `x-request-id`.
- Carry request ID, method, normalized route, authenticated numeric user ID, and runtime name through `AsyncLocalStorage`.
- Do not add message content, document content, cookies, authorization headers, API keys, tokens, or secrets to the request context.

Runtime, MCP, A2A, and knowledge integrations should reuse the same request ID when their protocols permit it.

## Structured Logs

Production logs are newline-delimited JSON written to stdout and retained by the process manager.

Required fields:

- `time`, `level`, `service`, `event`
- `requestId`, `method`, `route`
- `statusCode`, `durationMs`, `outcome`
- optional bounded identifiers such as numeric `userId`, `runtime`, and `operation`

The logger must redact common credential field names recursively. HTTP request and response objects, environment objects, request bodies, model prompts, tool arguments, and tool results must never be logged wholesale.

Existing `console.*` calls are migrated only when a module is touched. The first release does not rewrite the entire repository.

## Metrics

Prometheus metrics are exposed at `/internal/metrics`.

- Without `METRICS_BEARER_TOKEN`, only loopback connections are accepted.
- With a token, callers must send `Authorization: Bearer <token>`.
- Metrics labels use bounded categories only. User IDs, Agent IDs, conversation IDs, document IDs, filenames, and raw URLs are forbidden labels.

Initial metrics:

- HTTP request count and duration by method, normalized route, and status class
- in-flight HTTP requests
- Node.js process, event-loop, and memory defaults
- readiness checks by dependency and outcome
- application filesystem capacity and backup freshness
- bounded knowledge search, knowledge indexing, and expert task outcomes and duration
- server lifecycle state and requests tracked for graceful shutdown
- active, configured limit, and rejection count for each bounded capacity lane

Chat first-token latency, runtime calls, MCP calls, sandbox execution, and scheduled delivery will use the same registry in follow-up instrumentation.

## Health Endpoints

- `/health` and `/health/live`: process liveness only; no network or database calls.
- `/health/ready`: bounded checks for MySQL, the knowledge service, and JiuwenSwarm when enabled.
- administrator diagnostics remain separate and may perform slower checks.

Readiness failures return HTTP 503 with dependency names and bounded error codes, not connection strings or credentials.

During shutdown, readiness changes to `not_ready` before the listener stops accepting traffic. `EA_SHUTDOWN_QUIESCE_MS` leaves a short interval for the reverse proxy to observe that transition. New business requests receive a retryable HTTP 503, while existing HTTP, SSE, and WebSocket work receives up to `EA_SHUTDOWN_DRAIN_TIMEOUT_MS` to finish. PM2's kill timeout must be longer than the quiesce and drain windows combined.

PM2 runs the Node process directly with the `tsx` import hook. Do not wrap the production process in `pnpm start` or a shell script, because an intermediate process can absorb termination signals and bypass application draining.

## Capacity And Backpressure

The single-node baseline rejects excess work instead of creating unbounded in-memory queues.

- `EA_API_MAX_CONCURRENCY` bounds all API requests.
- `EA_CHAT_HTTP_MAX_CONCURRENCY` independently bounds long-lived SSE chat requests.
- `EA_CHAT_WS_MAX_CONNECTIONS` bounds legacy WebSocket chat connections.
- `DB_QUEUE_LIMIT` bounds MySQL pool waiters; `DB_CONNECTION_LIMIT` controls actual database connections.

Capacity errors return HTTP 503 with `Retry-After: 2`. Limits are deployment controls, not per-user quotas, and should be tuned from measured saturation and latency rather than raised automatically.

## Backup And Recovery

The production backup set must include:

1. MySQL, including triggers and audit tables.
2. Application data under `data/`, including knowledge documents, session revocations, skill package metadata, and retained operational state. Rebuildable knowledge indexes are excluded by default and may be enabled explicitly.
3. The configured skill store.
4. JiuwenSwarm configuration and per-Agent workspaces.
5. Task and expert artifacts that are not reproducible from MySQL.
6. Encrypted application and runtime configuration.

Targets:

- Daily local encrypted backup.
- Weekly encrypted off-site copy.
- Thirty-day default retention, configurable by deployment.
- A quarterly isolated restore exercise.
- Restore documentation records RPO, RTO, backup timestamp, source host, checksums, and validation results.

The backup process must not include caches, dependency directories, transient sandboxes, sockets, or process logs unless explicitly required for incident retention.

## Rollout

1. Land request context, logger, metrics, and health routes.
2. Validate locally with existing tests and a production build.
3. Enable JSON logs and loopback metrics in the production environment.
4. Extend backup coverage and perform an isolated restore.
5. Evaluate the conservative baseline alert rules locally, then connect an approved enterprise notification receiver after observing normal production ranges.
