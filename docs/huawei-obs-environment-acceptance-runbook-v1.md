# Huawei OBS Environment Acceptance Runbook V1

## Purpose And Boundary

This runbook verifies that the frozen OBS/S3 connector implementation at
`3574fd93555eb043c7fd8e2b8b9c173460b9f556` behaves correctly against a real,
non-production Huawei Cloud OBS environment.

This is environment acceptance, not feature development. Stop the run at
`Candidate / Remediation`. Do not approve, publish, stage, bind, or release any
acceptance asset into Production Context.

The frozen connector path covered by this runbook is:

```text
OBS Listing
  -> controlled download
  -> content validation and antivirus
  -> SHA-256 content identity
  -> Candidate / Remediation
```

`StandardParseResult` is not produced on this pre-Candidate connector path. It
is currently produced during later Knowledge indexing after an administrator
stages a Candidate into a Knowledge Base. Because this acceptance must stop at
Remediation, semantic parsing is intentionally not an acceptance gate. Wiring
`StandardParseResult` into pre-Candidate onboarding would be separate feature
development and is outside this frozen scope.

Target status after every mandatory gate passes:

> `Huawei Cloud OBS Connector V1: Environment Verified`

## Required Inputs

Record these values in the acceptance record. Never place credential values in
the record, source URI, screenshots, Asset Metadata, Binding, Receipt, or Git.

| Input | Requirement |
|---|---|
| Endpoint | Non-production Huawei OBS S3-compatible endpoint |
| Region | Region used for request signing |
| Bucket | Dedicated test bucket or explicitly approved shared bucket |
| Prefix | Isolated prefix used only by this acceptance run |
| Credential reference | For example `env://GRACE_OBS_DEMO_CREDENTIAL` |
| Runtime host | Host running the exact connector baseline |
| Operator | Cloud operator responsible for fixture upload and fault injection |
| Reviewer | GRACE administrator reviewing Source Runs and Candidates |

The credential must have only the approved equivalent of:

- list objects for the acceptance bucket/prefix;
- read objects for the acceptance prefix.

GRACE does not require write or delete permission. The cloud operator performs
fixture changes outside GRACE.

## Server Preparation

For `env://GRACE_OBS_DEMO_CREDENTIAL`, configure the runtime secret environment:

```text
GRACE_OBS_DEMO_CREDENTIAL_ACCESS_KEY_ID=<secret store value>
GRACE_OBS_DEMO_CREDENTIAL_SECRET_ACCESS_KEY=<secret store value>
GRACE_OBS_DEMO_CREDENTIAL_SESSION_TOKEN=<optional secret store value>
```

Allowlist the exact endpoint origin:

```text
ENTERPRISE_OBJECT_STORAGE_ENDPOINTS=https://obs.example-region.example.com
```

Do not print the process environment. Confirm only that the reference resolves
by registering the source and running the connector.

## Fixture Preparation

Choose a unique lower-case acceptance ID and an operator-local directory:

```bash
pnpm connector:obs:acceptance:fixtures -- \
  --phase=baseline \
  --acceptance-id=obs-bank-demo-001 \
  --root=/tmp/grace-obs-bank-demo-001
```

Upload only the generated `objects/` directory beneath the manifest's
`recommendedPrefix`. Do not upload the state or manifest files.

The baseline contains:

- 1,005 deterministic policy files to force more than one S3 listing page;
- Chinese, spaces, `+`, `#`, `%`, `?`, brackets, and nested object keys;
- one 16 MiB transport object that must be uploaded using multipart upload;
- one unsupported object that must be listed but skipped;
- 1,009 supported objects expected to become Candidates.

After upload, independently confirm that the large object's ETag exhibits the
environment's multipart behavior. Record the observed ETag; do not interpret it
as SHA-256.

## Pre-Acceptance Snapshot

Before source registration, record:

```bash
git rev-parse HEAD
pnpm context:quality:freeze
pnpm context:provider:llamaindex:baseline:verify
```

Record these fixed governance fingerprints:

```text
Context Quality: a7439134abfea0263864d9f37ffe3f8063892e498b49aa3df5c8e545e607c40a
LlamaIndex Config: 422e28500cdecbf8b48f608da6e63c7d9d7a4e992ad688120659ae934dd24e3f
LlamaIndex Certification: b0a7f5195398e22eae44c252e5443b5487153cb4d9223b9e9d781d31c5e1a9e7
```

From the administrator page, record current Candidate totals and confirm there
is no running Source Run for the planned Source ID.

## Source Registration

In `岗位资产接入 -> 登记来源`:

1. Select `制度/文档库`.
2. Select `OBS / S3 对象存储`.
3. Enter Endpoint, Region, Bucket, isolated Prefix, and Credential Reference.
4. Do not enter an Access Key or Secret Key in any UI field.
5. Save, select the source in `来源同步状态`, and capture the registered source
   without exposing any secret value.

## Gate 1: Baseline And Pagination

Run `立即同步` and verify:

| Assertion | Expected |
|---|---:|
| Complete Source Run | `succeeded`, `scanComplete=true` |
| Listed objects | 1,010 in fixture manifest/audit evidence |
| Created Candidates | 1,009 |
| Changed | 0 |
| Unchanged | 0 |
| Tombstones | 0 |
| Unsupported | 1 skipped |
| Listing pages | at least 2 |

Sample-check all special object keys, the large transport object, and at least
one item from each listing page. Confirm Candidate `sourceOriginUri`, object
size, ETag, and SHA-256 are present and that ETag is not copied into the content
hash. Confirm the large object passed download size checks, content validation,
and antivirus scanning; do not claim a `StandardParseResult` was generated.

Do not submit Candidates for approval.

## Gate 2: Unchanged Scan

Without changing OBS, run `立即同步` again:

```text
Created: 0
Changed: 0
Unchanged: 1009
Tombstones: 0
```

Confirm no duplicate Candidate was created and the Source Item identities are
unchanged.

## Gate 3: Download Failure And Resume

Generate the mutation set:

```bash
pnpm connector:obs:acceptance:fixtures -- \
  --phase=mutation \
  --acceptance-id=obs-bank-demo-001 \
  --root=/tmp/grace-obs-bank-demo-001
```

Upload the changed `objects/` tree to the same prefix. Before GRACE syncs it,
have the cloud operator temporarily deny `GetObject` only for the newly added
`bulk/policy-1006-V1.0.md`, or inject an equivalent non-production download
failure without changing GRACE code.

1. Run sync and confirm the Source Run is `failed`, `scanComplete=false`.
2. Confirm no Candidate from the failed Run was committed and no Tombstone was
   created.
3. Restore `GetObject` access.
4. Click `恢复同步`.

Expected recovered Run:

```text
Created: 1
Changed: 2
Unchanged: 1007
Tombstones: 0
resumeOfRunId: <failed run>
attempt: 2
```

Confirm both revisions keep their prior Enterprise Asset IDs and receive
non-overwriting revision versions.

## Gate 4: Transport Timeout Recovery

Using a pre-approved non-production network control, temporarily block or drop
runtime egress to the OBS Endpoint for one sync attempt. Do not change the
source URI or credentials.

1. Confirm the SDK exhausts its retry policy and the Source Run fails.
2. Confirm `scanComplete=false` and zero Tombstones.
3. Restore egress and use `恢复同步`.
4. Confirm the retry succeeds without new Candidates because the source is
   unchanged.

If controlled timeout injection is unavailable, record this gate as `BLOCKED`,
not `PASS`; the environment cannot be marked verified until it is executed.

## Gate 5: Incomplete Scan And Tombstone

Generate the deletion set and remove the corresponding object from the isolated
OBS prefix using the cloud operator's approved tool:

```bash
pnpm connector:obs:acceptance:fixtures -- \
  --phase=deletion \
  --acceptance-id=obs-bank-demo-001 \
  --root=/tmp/grace-obs-bank-demo-001
```

The deleted key is `bulk/policy-0002-V1.0.md`.

Before a successful full scan, temporarily deny `ListObjects` or block endpoint
egress and run sync:

- Run must fail with `scanComplete=false`.
- The deleted Source Item must remain active.
- No Tombstone Candidate may exist.

Restore the source and click `恢复同步`. Expected complete Run:

```text
Created: 0
Changed: 0
Unchanged: 1009
Tombstones: 1
```

Confirm the Tombstone remains a draft remediation item and does not retire or
publish the existing asset automatically.

## Gate 6: Browser Product Loop

Using a real administrator login, verify:

- registered Endpoint/Bucket/Prefix and Credential Reference are understandable;
- latest Run state and counts are visible;
- failure reason and `恢复同步` are visible after a failed Run;
- special-character Candidates open correctly;
- Revision and Tombstone diagnostics are understandable;
- desktop and mobile views have no inaccessible controls or horizontal overflow;
- no credential value appears in browser responses, Candidate data, audit data,
  Binding, or Receipt.

Stop at Remediation. Do not approve or release any test Candidate.

## Exit Criteria

All mandatory gates must be `PASS`:

- real Huawei OBS authentication and listing;
- more-than-1,000-object pagination;
- multipart ETag observed and never treated as content hash;
- Chinese and special-character keys preserved;
- object size limits, content validation, and antivirus invoked;
- unchanged scan creates no duplicate Candidate;
- revision preserves Enterprise Asset ID;
- download failure and transport timeout recover through a linked Run;
- failed/incomplete scans create no Tombstone;
- complete deletion scan creates exactly one draft Tombstone;
- browser administrator loop passes;
- no acceptance asset enters Production Asset Release;
- Context Quality and Provider Certification fingerprints remain unchanged.

Complete
`docs/templates/huawei-obs-environment-acceptance-record-v1.md`, attach bounded
evidence, and obtain both cloud operator and GRACE reviewer sign-off.
