# GRACE Customer Profile Source Remediation Plan V1

## Status

**Engineering Complete / Data Owner Review Pending / Runtime Unchanged**

The plan converts the local Source Readiness result into nine owned remediation
items. It is a proposed review artifact, not an active source mapping, Role
authorization or Production Binding change.

Machine-readable plan:

```text
examples/customer-profile-contract-v1/source-remediation-plan.v1.json
```

Plan fingerprint:

```text
b807dce2c46c5aafcd3a12cf68cea25285cdafd6051ab896040860217d734403
```

## Read-only source discovery

The existing Wealth source exposes candidate activity facts including a valid
customer indicator and 30/60/90/180-day contact counts. These paths are only
mapping candidates:

```text
data.activityInfo.PRVT_VLD_CUST_IND
data.activityInfo.LST_30_DAY_CNTCT_CNT
data.activityInfo.LST_60_DAY_CNTCT_CNT
data.activityInfo.LST_90_DAY_CNTCT_CNT
data.activityInfo.LST_180_DAY_CNTCT_CNT
```

Their codebooks and business time semantics are not registered. EA must not
interpret them as customer status or last-contact time without data-owner
confirmation.

The Insurance Demo MCP exposes:

```text
list_customer_profiles
get_customer_profile_by_name
```

The list contains an internal `id`, but point lookup still accepts a display
name. This does not satisfy the frozen stable-subject rule. The detail payload
also has no renewal, current-coverage, claims-summary or authoritative `asOf`
facts.

## Work items

| ID     | Owner                            | Required outcome                                 |
| ------ | -------------------------------- | ------------------------------------------------ |
| `W-01` | Wealth Customer Data Owner       | Confirm authoritative customer-status codebook   |
| `W-02` | Wealth CRM Data Owner            | Supply governed recent-contact facts             |
| `W-03` | Wealth Suitability Data Owner    | Supply horizon and liquidity facts               |
| `W-04` | Wealth Provider Owner            | Supply business `asOf` and provenance            |
| `I-01` | Insurance Provider Owner         | Add stable-subject point lookup                  |
| `I-02` | Insurance Authorization Owner    | Enforce organization/principal/purpose/row scope |
| `I-03` | Insurance Policy Data Owner      | Supply renewal, coverage and claims-risk facts   |
| `I-04` | Insurance Provider Owner         | Supply business `asOf` and provenance            |
| `X-01` | Enterprise Customer Master Owner | Govern cross-system subject identity             |

The complete IDs, fields and exit criteria are in the machine-readable plan.

## Verification

```bash
pnpm customer-profile:sources:remediation:verify
```

The verifier requires:

- all current readiness gaps have an owner;
- no credentials or raw customer values are stored;
- no auto-activation or auto-authorization is allowed;
- the frozen business and source-mapping fingerprints remain unchanged;
- a new source and authorization fingerprint plus a full Gate B rerun are
  mandatory before promotion.

## Review and activation boundary

All nine items currently have review status `proposed`. Data owners may move an
item to `domain_reviewing`, `domain_confirmed` or `needs_resolution`. Confirming
the plan alone does not make a source production-ready.

After implemented provider evidence is available, GRACE must create a new
source contract candidate and rerun:

```text
Source Readiness Gate
        ↓
New authorization fingerprint
        ↓
New immutable Gate B snapshot
        ↓
Dual-role Candidate Provided 3/3
        ↓
Promotion Review
```

No current Production Binding or Runtime path is changed by this plan.
