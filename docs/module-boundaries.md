# Module Boundary Plan

## Constraints

The refactor must preserve:

- all `/api/claw/*`, `/api/desktop/*`, and tRPC procedure names
- request and response payloads
- authentication and ownership checks
- database schema and migration history
- JiuwenSwarm and optional OpenClaw behavior
- the existing test baseline

File size is not itself the target. The target is one-directional dependencies, independently testable route groups, and explicit service boundaries.

## Skill Routes

`registerSkillRoutes(app)` remains the public facade. This change extracts:

- `skills/routes/skill-package-routes.ts`: inspect, upload, list, delete, legacy install compatibility
- `skills/routes/skill-market-routes.ts`: market list and submission

The next extraction keeps the same facade and adds:

- `skills/routes/mcp-tool-routes.ts`: MCP status and enablement
- `skills/routes/skill-registry-routes.ts`: registry list, introduction, reconcile, enable, uninstall, destroy, rename

Shared parsing, authorization, registry, and runtime synchronization stay in services outside route modules. Route modules must not import one another.

## tRPC Claw Router

The `claw` namespace remains unchanged. Procedure fragments are grouped by responsibility and spread into the existing router:

- identity and adoption
- memory
- model selection and model administration
- feedback
- role assets
- skill market administration
- settings and brand administration
- chat and skill readiness

Procedure fragments may depend on services and database repositories, but not on other procedure fragments.

## Miscellaneous HTTP Routes

`registerMiscRoutes(app)` remains the facade and delegates to:

- runtime and health routes
- chat history routes
- embedded authentication routes
- skill review/upload routes
- usage statistics routes

History parsing and artifact reconstruction move to pure modules with fixture tests before route movement.

## Desktop

Desktop is split only after the server modules above stabilize:

- authentication and bootstrap
- WebSocket chat transport
- session and model routes
- channel routes
- memory and soul routes
- cron routes
- workspace file routes

The WebSocket connection state remains owned by one transport module. It must not be distributed across route modules.

## Frontend Home

The main page is split last into stateful feature controllers and presentational sections. Shared chat stream state remains in one controller until characterization tests cover send, reconnect, history switch, expert handoff, workspace panels, and knowledge citations.

## Type Debt Policy

- The repository records the current `@typescript-eslint/no-explicit-any` warning count.
- CI fails when the total increases.
- New observability and extracted route modules treat explicit `any` as an error.
- Existing `any` is removed when a touched boundary receives a real schema or adapter type.
- Type assertions are not replaced with `unknown` unless narrowing is implemented.

## Extraction Order

1. Skill package safety and dead compatibility code.
2. Skill route groups.
3. Claw memory and model procedure fragments.
4. Remaining Claw administrative fragments.
5. Miscellaneous history and health routes.
6. Desktop routes.
7. Frontend Home.

Each extraction is a separate behavior-preserving commit with targeted tests, full typecheck, lint, test, and production build.
