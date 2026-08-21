# Huawei OBS Environment Acceptance Record V1

## Decision

| Field | Value |
|---|---|
| Status | `PENDING / PASS / FAIL / BLOCKED` |
| Acceptance ID | |
| Executed at | |
| Connector baseline | `3574fd93555eb043c7fd8e2b8b9c173460b9f556` |
| Runtime commit/release | |
| Environment | Non-production |
| Endpoint origin | |
| Region | |
| Bucket | |
| Prefix | |
| Credential reference | `env://...` only; never record values |
| Cloud operator | |
| GRACE reviewer | |

## Pre-Acceptance Snapshot

| Evidence | Before | After | Result |
|---|---|---|---|
| Candidate count | | | |
| Active Source Items | | | |
| Missing Source Items | | | |
| Running Source Runs | | | |
| Context Quality fingerprint | `a743...c40a` | | |
| Provider Config fingerprint | `422e...e3f` | | |
| Provider Certification fingerprint | `b0a7...a9e7` | | |
| Fixture manifest SHA-256 | | | |

## Environment Evidence

| Check | Observed | Result |
|---|---|---|
| Authentication with credential reference | | |
| Read-only permission scope | | |
| Endpoint allowlist | | |
| Chinese object key | | |
| Space/special-character object key | | |
| Multipart object ETag | | |
| Large object download/content validation | | |
| Antivirus status | | |
| StandardParseResult | `Not exercised; acceptance stops at Remediation` | `N/A` |

Do not paste Access Key, Secret Key, session token, Authorization headers, or
unbounded object contents into this record.

## Source Run Results

| Gate | Run ID | Status | Complete | Created | Changed | Unchanged | Tombstone | Result |
|---|---|---|---:|---:|---:|---:|---:|---|
| Baseline | | | | | | | | |
| Unchanged | | | | | | | | |
| Download failure | | | | | | | | |
| Download recovery | | | | | | | | |
| Transport timeout | | | | | | | | |
| Timeout recovery | | | | | | | | |
| Incomplete deletion scan | | | | | | | | |
| Complete deletion scan | | | | | | | | |

## Identity And Governance Assertions

| Assertion | Evidence reference | Result |
|---|---|---|
| More than one Listing page completed | | |
| ETag was not used as content hash | | |
| Unchanged scan created zero duplicate Candidates | | |
| Revision retained Enterprise Asset ID | | |
| Failed Runs committed no Candidate | | |
| Failed/incomplete Runs produced no Tombstone | | |
| Full deletion scan produced exactly one draft Tombstone | | |
| Credential values absent from Asset/Binding/Receipt/audit | | |
| No Candidate was approved, staged, bound, or released | | |

## Browser Evidence

| View | Evidence reference | Result |
|---|---|---|
| Source registration | | |
| Successful Run operations | | |
| Failed Run and recovery | | |
| Revision remediation | | |
| Tombstone remediation | | |
| Mobile layout | | |

## Exceptions

Record every deviation, unresolved compatibility issue, or blocked gate. A
mandatory `BLOCKED` or `FAIL` keeps the overall decision from becoming `PASS`.

| ID | Gate | Description | Owner | Disposition |
|---|---|---|---|---|
| | | | | |

## Sign-Off

Cloud operator:

```text
Name/role:
Decision:
Signed at:
Comment:
```

GRACE reviewer:

```text
Name/role:
Decision:
Signed at:
Comment:
```

Final status may be set to `PASS` only when every mandatory gate passes and no
test Candidate enters Production Asset Release.
