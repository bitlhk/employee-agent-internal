# EA Skill Market Versioning Plan v1

## Status

- Status: V1 implementation complete; local migration and write-path rehearsal
  passed; local and Shanghai release deployment pending
- Date: 2026-08-24
- Scope: Employee Agent Skill publishing, marketplace versioning, installation,
  update, rollback, and role-default preinstallation
- Out of scope: replacing the EA marketplace with SkillHub, using job roles as
  Skill access-control boundaries, and changing MCP/data authorization

## Decision Summary

EA will continue to operate its own Skill marketplace. The current marketplace
will be extended instead of introducing SkillHub.

The confirmed product model is:

1. Skill maintenance has exactly two modes: `system` Skills are maintained by
   platform administrators, and `user` Skills are maintained by one EA user.
2. Every authenticated EA user may upload, publish, and maintain their own
   `user` Skills. Administrators curate imported, partner, builtin, and official
   content as `system` Skills.
3. Every published version is reviewed independently. Only approved versions
   enter the EA marketplace.
4. Approved enterprise marketplace Skills are visible and installable by all
   authenticated users in the same organization. Explicit system-maintained Skills
   may be visible across organizations. Job roles do not filter either catalog.
5. Job roles do not authorize marketplace Skills. A role only determines which
   approved Skills are preinstalled by default.
6. MCP, knowledge-base, data-source, credential, and high-risk operation
   permissions remain independent server-side authorization boundaries.
7. Marketplace updates never overwrite an Agent runtime automatically.
8. Every installed marketplace Skill is pinned to an exact version and SHA-256
   digest until a user or administrator explicitly changes it.
9. Same-version overwrite is prohibited. A content change requires a new
   version.
10. A new version is created only through an explicit "publish new version"
    action on an existing immutable Skill identity. File names, display names,
    content similarity, and package digests never determine Skill identity.

The intended responsibility split is:

```text
Skill maintainer
  uploads and maintains Skill versions
          |
          v
EA marketplace
  owns version review, immutable artifacts, metadata, and discovery
          |
          +------------------------+
          |                        |
          v                        v
EA administrator             EA user
  configures role-default      installs and updates optional Skills
  preinstalls and rollout      in a personal Agent workspace
          |                        |
          +------------+-----------+
                       v
              Agent runtime workspace
```

## Why Roles Are Not a Skill Permission Boundary

A Skill describes a method, prompt, workflow, or local script. It must not grant
access to enterprise systems by itself. Installing a Skill must not implicitly
grant MCP credentials, knowledge access, data access, or approval authority.

Role-based authorization remains mandatory for:

- MCP servers and tools;
- enterprise knowledge bases and data sources;
- credentials and delegated identities;
- write operations and governed approvals;
- regulated or confidential business data.

For Skills, a role answers only: "What should this Agent have ready by
default?" It does not answer: "What is this user allowed to see or execute?"

Catalog visibility is independent from maintenance responsibility and job
roles. V1 supports `organization` and `platform` visibility: user-maintained
Skills default to the publisher's organization, while platform visibility is
reserved for administrator-controlled system Skills. Future `private` or `team` visibility may be added
without reintroducing job-role authorization as a proxy for confidentiality.

## Current Baseline

The existing implementation already provides useful foundations:

- `.zip` and `.skill` package inspection and upload;
- package-size, archive-envelope, path-traversal, symlink, encryption, and zip
  bomb defenses;
- local static checks and optional external AIG Skill scanning;
- SHA-256 calculation during personal package upload;
- personal uploaded/generated/runtime-imported Skill registration;
- user submission of a personal Skill to the marketplace review queue;
- administrator review, source preview, approval, rejection, and offlining;
- marketplace browsing, installation, update indication, and uninstallation;
- per-Agent workspace materialization for JiuwenSwarm and OpenClaw;
- role default/optional asset records and an administrator role configuration
  page;
- serialized registry mutations and focused Skill installer tests.

## Implemented V1 Baseline

The V1 delivery in this change adds the following production paths without
removing the legacy marketplace projection:

- immutable `skill_identities` with exactly two maintenance modes: `system`
  and `user`;
- immutable `skill_versions` with strict SemVer, SHA-256, independent review,
  version history, and a deterministic latest-approved pointer;
- administrator upload and subsequent system-Skill version publication;
- user publication and explicit new-version publication only for the same
  selected Skill identity owned by that user;
- server-side organization visibility checks for both marketplace discovery
  and exact-version installation;
- exact-version installation facts, assignment facts, and append-only
  install/update/rollback execution events;
- explicit manual update and rollback from the marketplace version history;
- digest verification before activation and atomic directory replacement that
  preserves the prior runtime if package activation fails;
- additive migration `0031_skill_market_versioning_v1.sql` and an idempotent
  legacy backfill that leaves the current runtime registry untouched;
- controlled normalization of the known legacy underscore-to-kebab Skill ID
  drift when the package manifest proves they are the same runtime identity;
- a write-enabled E2E verifier that creates and cleans a temporary user Skill,
  proves `1.0.0 -> 1.1.0 -> 1.0.0`, and verifies cross-organization denial.

Local migration rehearsal on 2026-08-24 produced 60 identities, 60 immutable
versions, and 110 exact existing installation records. Eight legacy registry
entries remain on the compatibility path: seven point to missing retired
sources and one runtime copy does not match any approved artifact digest. The
migration was run repeatedly with zero new identities or versions, and the
pre-existing `skill-registry.json` checksum remained unchanged.

The following broader roadmap items remain outside this V1 product cut:

- database-authoritative role-default preinstall rollout and Golden Task
  promotion (the new table and contract are reserved, while existing role
  defaults remain the compatibility path);
- automatic crash-lease reconciliation and revoked-version quarantine;
- removal of all legacy marketplace write/read projections;
- external artifact storage, artifact garbage collection, and cross-product
  Skill distribution.

Operational commands:

```bash
pnpm skills:market:v2:inventory -- --output=/tmp/skill-market-v2-inventory.json
pnpm db:migrate
pnpm skills:market:v2:migrate
pnpm skills:market:v2:e2e -- --allow-write
```

The E2E verifier is intentionally write-gated and removes its temporary
identity, releases, installation ledger, artifact, registry entry, and runtime
copy before exit.

Before this V1 change, the implementation was not yet a durable
version-management system:

- `skill_marketplace` combines Skill identity and one version in a single row;
- there is no unique `(skill, version)` constraint or immutable release ledger;
- package SHA-256 is not attached to marketplace approval and installation;
- an approved directory can change without the installer detecting it;
- Agent marketplace source paths are keyed by `skillId`, so updates replace the
  previous source;
- update removes existing files before the replacement is proven usable;
- downgrade is rejected, so rollback is not supported;
- installed marketplace state is file-backed rather than a transactional
  database fact;
- users can submit a Skill but cannot manage their marketplace releases or see
  version history and review status;
- marketplace lists are already globally visible, while the administrator UI
  labels Skill role configuration as authorization, creating misleading
  semantics;
- no backend route/integration tests cover marketplace publish, review,
  authorization, update failure recovery, or rollback.

## Goals

1. Let every authenticated user manage their own marketplace Skills safely.
2. Preserve every approved release as an immutable, digest-addressed artifact.
3. Make the installed version of every Agent marketplace Skill explicit and
   recoverable.
4. Support safe manual update and rollback without runtime downtime caused by a
   partial file replacement.
5. Retain the existing role-default Skill experience while removing misleading
   Skill authorization semantics.
6. Migrate existing marketplace entries and Agent installations without losing
   current workflows.
7. Keep already installed Skills runnable when the marketplace database or
   release service is temporarily unavailable.
8. Preserve organization isolation without turning job roles into Skill catalog
   authorization rules.
9. Require role-default Skill version changes to use the existing Role Pack and
   Golden Task release discipline before rollout.

## Non-Goals

- Public anonymous Skill distribution.
- Cross-product Skill distribution.
- Git repository batch synchronization.
- More than the two maintenance modes `system` and `user` in v1. Organization is
  retained as catalog visibility and tenant isolation, not introduced as a
  third maintenance actor.
- Automatic dependency resolution between Skills.
- Automatic execution of newly approved code in existing Agent workspaces.
- Automatic role-wide update when a maintainer publishes a new version.
- Migrating all builtin, generated, and uploaded Skill runtime records to the
  database in this change.

## Domain Model

### Skill Identity

A Skill identity is maintained either by platform administrators (`system`) or
by one EA user (`user`). It belongs to an organization catalog or the platform
catalog and is independent from its versions.

Recommended table: `skills`.

| Field                        | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `id`                         | Internal immutable numeric or UUID identity                |
| `skill_id`                   | Globally unique runtime slug                               |
| `maintainer_type`            | `system` or `user`                                         |
| `maintainer_user_id`         | Required only for user-maintained Skills                   |
| `organization_id`            | Catalog organization; required for organization visibility |
| `source_origin`              | User, community, partner, builtin, or official provenance  |
| `upstream_author`            | Original attribution; not EA maintenance authority         |
| `upstream_repository`        | Optional canonical source repository or location           |
| `upstream_license`           | Reviewed redistribution and use terms                      |
| `display_name`               | Marketplace display name                                   |
| `description`                | Current marketplace summary                                |
| `category`                   | Search and presentation category                           |
| `visibility`                 | `organization` or `platform`; platform is admin-controlled |
| `status`                     | `active` or `archived`                                     |
| `latest_approved_version_id` | Current default version for new installs                   |
| timestamps                   | Creation and update audit fields                           |

Rules:

- `skill_id` is globally unique because runtime workspaces and existing role
  defaults address Skills by this slug.
- The first accepted submission reserves `skill_id` with one immutable
  maintenance mode.
- A user may create only a `user` Skill bound to their own user identity and an
  organization where they hold active membership.
- Only platform administrators may create or publish versions for a `system`
  Skill or move it into `platform` visibility.
- Only the assigned user maintainer may publish another version for a `user`
  Skill. Administrators review, revoke, or reassign through audited governance;
  they do not silently publish as the user.
- `skill_id` cannot be renamed after the first approved release.
- Archiving a Skill hides it from new discovery but does not delete artifacts
  required by existing installations.

### Skill Identity and Upgrade Decision

The system never infers an upgrade from a file name, display name, description,
content similarity score, or matching SHA-256. Publishing has two explicit
entry points:

```text
Create new Skill
  -> reserve a new skill_id
  -> create version 1.0.0 (or another valid first version)

Publish new version
  -> select a Skill identity maintained by the current user or administrator
  -> package skill_id must match the selected immutable skill_id
  -> create a new, unique, strictly greater version
```

Server decisions:

- system Skill and administrator actor: eligible for a new-version submission;
- user Skill and matching user maintainer: eligible for a new-version submission;
- maintenance mode or user maintainer mismatch: reject;
- different `skill_id`: a new Skill identity, even when content is similar;
- same artifact digest with a new version: reject by default as an unchanged
  release unless an audited administrator exception is explicitly supported
  later;
- display-name changes never create or merge Skill identities.

Similarity checks may generate a duplicate warning for human review, but they
must never merge identities or select an update target automatically.

### Skill Version

Recommended table: `skill_versions`.

| Field                     | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `id`                      | Immutable version identity                             |
| `skill_identity_id`       | Foreign key to `skills.id`                             |
| `version`                 | Strict `MAJOR.MINOR.PATCH` version                     |
| `artifact_sha256`         | SHA-256 of the exact reviewed package bytes            |
| `artifact_size`           | Package size in bytes                                  |
| `artifact_path`           | Immutable storage location                             |
| `upstream_revision`       | Optional upstream tag, commit, or release identifier   |
| `manifest_json`           | Normalized manifest metadata                           |
| `changelog`               | Author-provided release notes                          |
| `status`                  | Version review lifecycle state                         |
| `review_note`             | Administrator review result                            |
| `submitted_by`            | User who submitted this exact digest for review        |
| `reviewed_by`             | Administrator who made the review decision             |
| `reviewed_at`             | Review decision time                                   |
| `scan_json`               | Static and external scanner result bound to the digest |
| `scan_policy_fingerprint` | Scanner/rule policy used for the decision              |
| `published_at`            | Approval time                                          |
| timestamps                | Submission and update audit fields                     |

Required constraints:

```text
UNIQUE(skill_identity_id, version)
UNIQUE(artifact_sha256) is not required: identical content may be reused
CHECK artifact_sha256 is a 64-character lowercase hexadecimal value
```

Version values in v1 are limited to three numeric components such as `1.2.0`.
The `v` prefix, prerelease labels, build metadata, and same-version overwrite
are rejected. Use a direct `semver` dependency; remove the current custom
version comparison implementation.

Review approval must enforce `reviewed_by != submitted_by`. For user-maintained
Skills, it also enforces `reviewed_by != skills.maintainer_user_id`. Reviewer
identity and decision are authoritative version facts, not only best-effort
audit metadata.

### Agent Installation

Recommended effective-state table: `agent_skill_installations`.

This table is authoritative only for marketplace installations in v1. Existing
file registry behavior may remain for builtin, generated, uploaded, and
runtime-imported Skills.

| Field                    | Purpose                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `adopt_id`               | Agent instance                                                                            |
| `skill_identity_id`      | Installed Skill identity (`skills.id`)                                                    |
| `active_version_id`      | Last version proven active in the runtime                                                 |
| `desired_version_id`     | Version requested by the effective assignment                                             |
| `active_artifact_sha256` | Digest proven active in the runtime                                                       |
| `enabled`                | Agent-level enabled state                                                                 |
| `install_state`          | `ready`, `installing`, `updating`, `rolling_back`, `failed`, `quarantined`, or `disabled` |
| `operation_id`           | Current install/update/rollback operation identity                                        |
| `operation_generation`   | Compare-and-swap generation for recovery                                                  |
| `lease_expires_at`       | Mutation lease expiry for crash recovery                                                  |
| `last_error`             | Bounded failure reason without sensitive package content                                  |
| `installed_by`           | User or administrator actor                                                               |
| `installed_at`           | Successful activation time                                                                |
| timestamps               | Last state transition                                                                     |

Required constraint:

```text
UNIQUE(adopt_id, skill_identity_id)
```

The database separately records desired and last-proven-active state. The
runtime registry remains a projection used to materialize and reconcile files.
It must be possible to rebuild a missing runtime copy from the active version
and immutable artifact, or complete/roll back an interrupted operation by
comparing `operation_id`, generation, and the runtime digest.

### Installation Assignments

One Agent may have more than one reason for the same Skill to exist. For
example, a user may personally pin `skill-a@1.0.0` before an administrator adds
`skill-a@2.0.0` as a role default. A single installation row cannot preserve
both intentions.

Recommended table: `agent_skill_assignments`.

| Field                  | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `adopt_id`             | Agent instance                                     |
| `skill_identity_id`    | Skill identity (`skills.id`)                       |
| `assignment_type`      | `personal` or `role_preinstall`                    |
| `assignment_ref`       | User assignment or role-preinstall record identity |
| `requested_version_id` | Exact requested approved version                   |
| `enabled`              | Whether this assignment participates in resolution |
| timestamps             | Audit and reconciliation timestamps                |

The effective materialization resolver uses deterministic precedence:

```text
active role_preinstall assignment
        >
active personal assignment
        >
not installed
```

Removing a role preinstall restores a still-enabled personal assignment instead
of losing the user's previous version choice. `agent_skill_installations`
records only the resolved effective runtime state.

### Install Events

Recommended table: `agent_skill_install_events`, or equivalent structured audit
events if query performance and retention are sufficient.

Record at least:

- install requested/succeeded/failed;
- update requested/succeeded/failed;
- rollback requested/succeeded/failed;
- digest mismatch;
- security rejection;
- runtime restore after failure.

### Role-Default Preinstallation

Skill preinstallation is not authorization and should not remain permanently
mixed with MCP authorization rows. Introduce a dedicated
`role_skill_preinstalls` table with at least:

```text
role_key
skill_identity_id
active_version_id
candidate_version_id
status = active | validating | disabled
validation_release_id
updated_by / updated_at
```

Keep the existing role asset data only as a migration compatibility source:

- Skill `default` rows are converted into role preinstall records;
- Skill `optional` rows are removed or ignored;
- `role_key=* + optional + source=market` synchronization is removed;
- the administrator label changes from "Skill role authorization" to "Role
  default preinstallation";
- MCP `default` and `optional` authorization semantics remain unchanged;
- bundled/builtin Role Pack Skills that are not marketplace-backed stay on the
  existing Role Pack asset path in v1 and are not forced into marketplace
  version records.

`pinned` is the only v1 policy. An administrator must explicitly propose a new
candidate version. A candidate does not change existing Agents until it passes
the role release gate:

```text
Pinned Version Candidate
        -> affected Role / Golden Task analysis
        -> Golden Task against the candidate artifact SHA-256
        -> Receipt proves the candidate was actually Provided
        -> administrator Promote
        -> controlled Agent reconciliation
```

Golden Task success without the candidate version and digest in Provided
Context/runtime evidence is a failed validation. This prevents a maintainer
release or an unverified administrator pin from changing every Agent in a role.

## Artifact Storage

Store exact reviewed package bytes under an immutable path:

```text
skill-store/marketplace/artifacts/<skillId>/<version>/<sha256>/package.skill
```

Optional extracted content may be cached below the same digest directory, but
the package is the source of truth:

```text
skill-store/marketplace/artifacts/<skillId>/<version>/<sha256>/content/
```

Rules:

1. Write to a temporary location.
2. Calculate SHA-256 from the final package bytes.
3. Validate and scan the exact package.
4. Atomically rename it into the digest-addressed location.
5. Never modify files under a committed artifact path.
6. Verify the digest again before every install, update, and rollback.
7. Do not delete an artifact referenced by an Agent installation or approved
   version.
8. Build migrated directory artifacts from a locked source snapshot using a
   canonical entry order, normalized timestamps, and normalized permissions so
   repeated packaging produces the same bytes and digest.

The initial implementation may continue using the local Skill store. Object
storage is not required for v1, but artifact access must be isolated behind a
service interface so S3/OBS can be introduced later without changing the
marketplace domain model.

Local artifact storage in v1 is a single-writer deployment constraint. Process
local mutexes are insufficient for multiple EA writers. A multi-instance
deployment must use shared artifact storage plus database-backed leases/CAS
before enabling marketplace mutations on more than one writer.

## Version Lifecycle

Version states:

```text
pending -> approved
pending -> rejected
approved -> withdrawn
approved -> revoked
```

- `pending`: visible to the maintainer and reviewers only.
- `approved`: visible in version history and installable.
- `rejected`: visible to the maintainer and reviewers; not installable.
- `withdrawn`: unavailable for new installs but retained for audit and existing
  installations. Use for normal maintainer/admin retirement.
- `revoked`: blocked because of a security or compliance issue. Rollback to a
  revoked version is forbidden. Affected installations are quarantined from new
  runtime sessions and reconciled to an approved replacement or disabled state.

Approving a new version updates `latest_approved_version_id` but does not
offline or delete older approved versions. Older approved versions remain valid
rollback targets.

Approved and referenced version records are immutable. Review state changes,
withdrawal, and revocation are append-only audited operations.

Revocation is an exceptional security control, not a normal marketplace update.
It must:

1. prevent new install, update, rollback, and role-preinstall resolution;
2. enumerate every affected assignment and effective installation;
3. prevent the revoked runtime copy from being linked into new Agent sessions;
4. trigger controlled disable or replacement reconciliation;
5. retain artifact bytes and evidence for audit;
6. emit a required audit event and operational alert.

Marketplace unavailability does not disable an already installed approved
version, but a locally persisted, verified revocation state continues to apply
when the remote catalog is unavailable.

## Publishing Workflow

### First Release

1. An authenticated user creates a `user` Skill, or an administrator creates a
   `system` Skill from official, partner, builtin, or imported content.
2. Server validates the actor's maintenance authority and parses the package.
3. The actor confirms maintenance mode, Skill ID, visibility, display name,
   description, category, version, changelog, and upstream provenance when
   applicable.
4. Server reserves the globally unique Skill ID with the selected maintenance
   mode and user maintainer, if any.
5. Server creates the immutable package and SHA-256 digest.
6. Static and external security scans are bound to the digest.
7. A `pending` version is created.
8. Administrator reviews the exact digest and source preview.
9. Approval makes the Skill visible in its organization or platform catalog.

### New Version

1. A user maintainer opens "My publications", or an administrator opens "System
   Skills", and selects an immutable Skill identity they maintain.
2. The maintainer uploads changed content whose package Skill ID matches that
   identity and whose version is strictly greater.
3. A new immutable artifact and independent review record are created.
4. Existing approved versions and Agent installations remain unchanged.
5. After approval, new installs default to the new latest version.
6. Existing installations show an update badge.

### Maintainer Controls

User maintainers may manage only their own `user` Skills. Administrators may
manage all `system` Skills. Both may:

- list their Skills and all submitted versions;
- view review and scanner results;
- submit a new version;
- update non-identity marketplace metadata;
- withdraw a version subject to retention rules;
- archive their Skill if no business rule prevents it.

Maintainers may not:

- modify approved artifact bytes;
- reuse a version number with different content;
- silently change maintenance mode or user maintainer in v1;
- approve their own release;
- delete audit history or artifacts used by an Agent.

## Marketplace Behavior

The marketplace displays one card per Skill, not one card per version.

The card uses the latest approved version and shows:

- author;
- latest approved version;
- installed version for the selected Agent;
- update availability;
- category and description;
- review/security status;
- install count.

All authenticated users in the same organization receive the same approved
organization catalog, plus explicitly platform-visible system Skills. `roleTag` may be
retained as a recommendation/search attribute but must not be treated as an
authorization decision.

The installation API must still verify:

- authenticated user owns the target Agent;
- requested Skill and version are approved and available;
- digest and package validation pass;
- runtime policy allows the package to be materialized.

It does not check job-role Skill authorization.

## Install, Update, and Rollback

### Manual Installation

1. Resolve the requested version, defaulting to `latest_approved_version_id`.
2. Acquire a database-backed `(adoptId, skillId)` mutation lease and create an
   operation record with a new generation.
3. Read and verify the immutable artifact SHA-256.
4. Re-run required package validation and enforce scanner policy.
5. Extract into a staging directory on the same filesystem as the target.
6. Verify root `SKILL.md`, Skill ID, runtime permissions, and size limits.
7. Persist `desired_version_id`, `operation_id`, and `updating` before changing
   runtime files while leaving `active_version_id` unchanged.
8. Rename the existing target to an operation-scoped backup if it exists.
9. Atomically rename staging to the runtime target.
10. Verify the active runtime digest and reconcile the runtime projection.
11. Compare-and-swap the installation row to the new `active_version_id`,
    digest, `ready` state, and incremented generation.
12. Remove the temporary backup only after the active-state commit succeeds.

If a handled failure occurs after backup creation, restore the previous runtime
directory and leave the last successful active version unchanged. If the
process exits between filesystem and database steps, startup reconciliation
uses the operation record, lease, active/desired versions, backup, and runtime
digest to deterministically complete or restore the operation.

### Manual Update

An update is an exact-version installation where the target version is newer
than the installed version. The UI shows both versions before confirmation.

A maintainer publishing a new version never triggers this operation automatically.

### Rollback

A user may roll a personally installed marketplace Skill back to any approved,
available older version. Rollback uses the same staged installation path as an
update; it is not a special file-copy shortcut.

For a role-default Skill:

- users may disable and re-enable the Skill;
- users may not independently change its administrator-pinned version;
- administrators propose a pinned version, pass the Role Pack/Golden Task gate,
  promote it, and initiate controlled Agent reconciliation;
- rollback is an administrator change of the pinned version followed by the
  same controlled reconciliation.

## Security Policy

Organization-wide marketplace visibility is acceptable only when package
security is enforced independently from job roles. Cross-organization
visibility is limited to explicitly platform-visible system Skills.

Required controls:

1. Bind review, scanner output, and installation to the same SHA-256 digest.
2. Block approval when static validation fails.
3. Change the external scanner from observation-only to enforcement for
   `critical` and `high` findings before enabling unrestricted user publishing.
4. Reject packages containing credentials, private keys, access tokens, or
   environment secret files.
5. Preserve current archive traversal, symlink, encryption, file-count, size,
   and compression-ratio protections.
6. Normalize runtime file permissions after extraction.
7. Keep tool, data, knowledge, network, and write-operation authorization on the
   server side. A Skill instruction cannot grant those permissions.
8. Audit publisher, reviewer, installer, target Agent, version, and digest.
9. Support emergency version revocation and detection of affected Agents.

## Service Boundaries

Introduce explicit services instead of extending filesystem logic directly in
routers:

```text
SkillCatalogService
  maintenance mode, organization-scoped visibility, metadata, list/detail, latest approved version

SkillReleaseService
  package creation, SemVer validation, review lifecycle, immutable artifacts

AgentSkillInstallationService
  assignment resolution, install, update, rollback, database lease/CAS,
  runtime activation, recovery

RoleSkillPreinstallService
  candidate pins, Golden Task release gate, administrator Promote, rollout
```

Use Express streaming routes only for binary package transfer. Prefer typed
tRPC procedures for metadata, review, install commands, and administrative
configuration. Existing endpoints may remain as compatibility adapters during
migration.

Suggested public application operations:

```text
publisher.listMine
publisher.createSkill
publisher.publishVersion
publisher.listVersions

market.listSkills
market.getSkill
market.listApprovedVersions

agentSkill.install
agentSkill.update
agentSkill.rollback
agentSkill.uninstall

adminSkill.listPendingVersions
adminSkill.listSystemSkills
adminSkill.createSystemSkill
adminSkill.publishSystemVersion
adminSkill.reviewVersion
adminSkill.revokeVersion
adminSkill.setRolePreinstall
adminSkill.rolloutRolePreinstall
```

`publisher.publishVersion` always requires an existing user-maintained Skill
identity selected from `publisher.listMine`; it never accepts a free-form
existing `skill_id` as proof of maintenance authority. The corresponding
administrator operation requires a selected system-maintained identity.
`publisher.createSkill` and `adminSkill.createSystemSkill` are the only
operations that reserve new identities.

## Migration Plan

### Inventory Gate

Before schema changes, produce a dry-run report containing:

- duplicate `skill_id` values across user maintainers and origins;
- user maintainers without an active organization membership and rows whose
  intended organization cannot be determined;
- malformed and duplicate version values;
- missing marketplace package paths;
- package paths outside `SKILL_STORE`;
- marketplace rows whose package digest cannot be generated;
- registry marketplace entries that cannot be mapped to a market row;
- active role Skill grants using `optional`;
- Agent/Skill collisions where both personal and role-default intent currently
  exist;
- approved records whose source fails current validation.

Rows without `author_user_id` receive a deterministic `system` maintenance
proposal because they were centrally imported. Rows with `author_user_id`
receive a `user` proposal for that user. Do not automatically choose a user
maintainer when multiple users currently claim the same Skill ID; require an
explicit migration decision.

### Phase 0 Local Inventory Baseline

The initial read-only inventory was executed on the local operating environment
on 2026-08-24. It made no database, registry, package, or runtime changes.

| Fact                                               | Count |
| -------------------------------------------------- | ----: |
| Legacy marketplace rows                            |    62 |
| Distinct `skill_id` values                         |    60 |
| Approved rows                                      |    60 |
| Marketplace registry installations                 |   118 |
| Active role Skill grants                           |    60 |
| Proposed system-maintained rows                    |    51 |
| Proposed user-maintained rows                      |    11 |
| Rows currently safe for automatic V2 migration     |    35 |
| Rows requiring a migration decision or remediation |    27 |

The main migration findings are:

- 51 centrally imported rows now have deterministic `system` maintenance
  proposals; 11 rows with `author_user_id` have `user` proposals;
- nine proposed user maintainers lack an active runtime organization membership
  and require catalog-scope resolution;
- 10 versions use legacy prerelease-like labels that do not satisfy the strict
  V1 SemVer contract;
- one `skill_id + version` pair is duplicated;
- 41 package paths are outside the canonical `SKILL_STORE`; the migration can
  copy them deterministically into immutable artifact storage;
- nine packages declare a different Skill ID from the legacy marketplace row;
- 70 installed registry references have a missing or mismatched legacy
  marketplace row reference;
- 34 active `optional` role Skill grants are compatibility data and must not be
  migrated as authorization rules.

These findings are migration-readiness issues, not evidence that the currently
installed runtime Skills are unavailable. Existing read and execution paths
remain unchanged until the V2 shadow and cutover gates are completed.

Re-run the dry-run inventory with:

```bash
pnpm skills:market:v2:inventory -- --output=/tmp/skill-market-v2-inventory.json
```

Add `--require-clean` only in a migration gate; it returns a non-zero exit code
when blockers or warnings remain.

### Backfill

1. Create new tables and indexes without changing current reads.
2. Group current marketplace rows into Skill identities.
3. Assign `system` maintenance when `author_user_id` is absent; preserve
   upstream author, repository/revision, and license separately from maintenance
   authority.
4. Assign `user` maintenance from `author_user_id`; require explicit resolution
   when multiple user maintainers claim one Skill ID.
5. Assign organization visibility from the user maintainer's active membership,
   or the configured system catalog scope; require an explicit administrator
   decision for ambiguous or missing membership.
6. Convert each valid marketplace row into a version record.
7. Build a deterministic package from a locked current-directory snapshot and calculate
   SHA-256.
8. Copy the artifact into the immutable storage path.
9. Preserve the current approved row as the initial latest approved version.
10. Import older offline rows as `withdrawn` unless an administrator explicitly
    confirms they are valid approved rollback versions.
11. Backfill personal and role-preinstall assignments, then derive effective
    Agent installation rows from registry `marketplaceId + version` data and
    current role defaults.
12. Convert marketplace-backed Skill role `default` rows into dedicated role
    preinstall configuration and
    remove/disable Skill `optional` and global `*` market rows.
13. Leave bundled/builtin Role Pack defaults on their existing source path.

### Cutover

Use feature flags for controlled activation:

```text
EA_SKILL_MARKET_V2_WRITE_ENABLED
EA_SKILL_MARKET_V2_READ_ENABLED
EA_SKILL_INSTALL_V2_ENABLED
```

Recommended order:

1. shadow-write new release records while old reads continue;
2. compare old and new catalog results;
3. switch administrator review to version records;
4. switch marketplace reads;
5. switch install/update/rollback;
6. run Agent reconciliation and integrity reports;
7. retain old tables and directories read-only for one release cycle;
8. remove compatibility paths only after restore and rollback drills pass.

## Implementation Phases

### Phase 0: Contracts and Inventory

- Add SemVer and lifecycle unit tests first.
- Define typed Skill identity, version, installation, and preinstall contracts.
- Define explicit create-new versus publish-new-version commands and
  system/user maintenance checks.
- Define organization catalog visibility and single-writer artifact constraints.
- Build the migration inventory command and resolve production collisions.
- Freeze current marketplace schema writes during final migration rehearsal.

Exit gate: inventory has no unresolved maintainer, version, or missing-artifact
conflict.

### Phase 1: Version and Artifact Foundation

- Add `skills`, `skill_versions`, `agent_skill_assignments`,
  `agent_skill_installations`, operation/event, and `role_skill_preinstalls`
  migrations.
- Add immutable artifact storage service.
- Bind SHA-256 and scanner output to version records.
- Add strict version validation and uniqueness enforcement.
- Implement compatibility reads from current market rows.

Exit gate: publishing two versions creates two immutable artifacts; attempting
same-version overwrite fails deterministically.

### Phase 2: Maintainer and Review Experience

- Add "My publications" UI.
- Add administrator "System Skills" maintenance UI.
- Add first release and new-version workflows.
- Add release history, changelog, and review-state display.
- Change administrator review from market-row review to version review.
- Enforce reviewer/submitter separation, system/user maintenance authority, and
  organization-scoped catalog visibility.
- Keep older approved versions available.

Exit gate: two different users cannot claim the same Skill ID, a user cannot
modify another user's Skill, and only administrators can publish system Skill
versions.

### Phase 3: Marketplace and Role Simplification

- Return one marketplace card per Skill within the caller's organization scope,
  plus platform-visible system Skills.
- Remove Skill role filtering and optional authorization semantics.
- Rename administrator Skill configuration to role default preinstallation.
- Remove global `* + optional` Skill grant synchronization.
- Add pinned approved version to role defaults.
- Add candidate pin, Golden Task Provided-evidence check, and Promote state.
- Leave MCP role authorization unchanged.

Exit gate: every user sees the same approved catalog, while role defaults differ
only in automatic preinstallation.

### Phase 4: Safe Installation, Update, and Rollback

- Add transactional Agent installation records.
- Add assignment resolution and preserve personal intent under role defaults.
- Add database-backed per-Agent/Skill leases, generations, and operation records.
- Implement digest verification and staged atomic activation.
- Implement update and rollback commands.
- Add failure recovery and startup reconciliation.
- Add role-default controlled rollout and rollback.
- Add revoked-version quarantine and startup recovery.

Exit gate: injected failures at download, validation, extraction, activation,
database commit, and runtime refresh leave the previous version runnable.

### Phase 5: Migration and Production Cutover

- Execute backfill and artifact generation.
- Run old/new catalog comparison.
- Canary the v2 marketplace and installer.
- Reconcile all existing marketplace installations.
- Run backup, restore, update, rollback, and revocation drills.
- Remove old write paths after the observation period.

Exit gate: no unmapped installation, digest mismatch, cross-user maintenance
violation, or unavailable role-default Skill remains.

## Test Plan

### Unit Tests

- strict version parsing and ordering;
- same-version rejection;
- system/user maintenance and immutable identity rules;
- explicit create-new versus publish-new-version decisions;
- organization visibility and platform-scope restrictions;
- version lifecycle transitions;
- artifact path and digest validation;
- latest approved version resolution;
- role-default preinstall projection;
- revoked version rejection.

### Database Integration Tests

- unique Skill ID and `(skill, version)` constraints;
- concurrent publication of the same Skill/version;
- review transition transactionality;
- installation current/previous version updates;
- installation active/desired generation and expired-lease recovery;
- personal versus role-preinstall assignment precedence;
- role preinstall pinned-version consistency;
- migration idempotency.

### Installer Fault-Injection Tests

- digest mismatch;
- missing or invalid `SKILL.md`;
- extraction and permission failure;
- staging rename failure;
- runtime refresh failure;
- database commit failure after staging;
- process termination after runtime rename and before active-state commit;
- stale lease takeover and operation-generation mismatch;
- update failure with old version preserved;
- rollback to approved version;
- rollback to withdrawn or revoked version rejected according to policy.

### API and Authorization Tests

- user can manage only their own publications;
- user cannot publish a new version by supplying another user's `skill_id`;
- non-administrator cannot create or publish a system Skill;
- user can install only into their own Agent;
- all authenticated roles in one organization see the same approved
  organization catalog;
- users in another organization cannot see enterprise Skill metadata or source;
- only platform administrators can create platform-visible Skills;
- pending/rejected versions are invisible to other users;
- Skill install does not grant MCP, knowledge, or data access;
- administrator-only review, revocation, and role-preinstall operations.
- reviewer cannot approve a version they submitted or personally maintain;
- role-preinstall Promote requires Golden Task evidence for the exact candidate
  version and SHA-256.

### End-to-End Acceptance

1. User A publishes `wealth-manager-assistant@1.0.0`.
2. Administrator approves it and configures it as a Wealth Manager default.
3. A new Wealth Manager Agent receives exactly `1.0.0`.
4. User B in the same organization but another role can find and manually
   install `1.0.0`; a user in another organization cannot see it.
5. User A publishes `1.1.0`; existing Agents remain on `1.0.0`.
6. User B manually updates and receives `1.1.0` after digest verification.
7. User B rolls back to `1.0.0`.
8. Administrator moves the Wealth Manager default to `1.1.0` and performs a
   candidate validation; Golden Task Receipt proves `1.1.0` and its digest were
   Provided before Promote and controlled rollout.
9. An injected rollout failure leaves affected Agents on their prior working
   version.
10. Neither Skill version changes MCP or enterprise data authorization.
11. If the same Agent already has a personal `1.0.0` assignment, the role
    default takes precedence while active and the personal version is restored
    when the role default is removed.
12. Revoking `1.1.0` prevents new sessions from linking it and produces an
    auditable replacement/disable plan for affected Agents.

## Operational Requirements

- Metrics for publish, review, install, update, rollback, digest mismatch,
  scanner rejection, recovery, and artifact storage size.
- Alert on digest mismatch, repeated activation failure, and revoked installed
  versions.
- Alert on expired mutation leases, unresolved active/desired divergence, and
  role rollout Golden Task failures.
- Backup both database version metadata and immutable artifact storage.
- Restore drills must verify that an installation row can rematerialize its
  exact runtime version.
- Artifact garbage collection must be reference-aware and disabled until the
  initial migration observation period ends.

## Estimated Delivery

For one engineer familiar with the current Skill runtime:

- Phase 0: 1-2 engineering days;
- Phase 1: 4-6 engineering days;
- Phase 2: 3-5 engineering days;
- Phase 3: 2-3 engineering days;
- Phase 4: 5-8 engineering days;
- Phase 5: 3-5 engineering days including rehearsal and cutover.

Expected total: approximately 3-4 weeks, depending on production data conflicts
and the external scanner enforcement work.

## Definition of Done

The project is complete when:

- users can publish and manage only their own Skills and versions;
- administrators can publish and manage system Skills without assigning them to
  a fake user owner;
- enterprise Skill discovery is organization-isolated and remains independent
  from job-role filtering;
- every approved version has immutable bytes and a verified SHA-256 digest;
- old approved versions remain available for supported rollback;
- marketplace updates do not alter installed Agent workspaces automatically;
- every marketplace installation records exact version and digest;
- failed update and rollback operations preserve the previous working runtime;
- interrupted operations recover deterministically from active/desired state,
  operation generation, lease, and runtime digest;
- all authenticated users in one organization see the same approved catalog,
  plus platform-visible system Skills;
- roles configure only pinned default preinstallation;
- role-default version changes require candidate Golden Task evidence and
  explicit Promote;
- personal and role-preinstall assignments remain independently recoverable;
- Skill installation cannot expand MCP, knowledge, or data permissions;
- migration, backup, restore, and revocation drills pass;
- unit, integration, API, installer fault-injection, and end-to-end gates pass.
