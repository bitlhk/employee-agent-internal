# GRACE Customer CRM Environment Acceptance V1

## Result

```text
Twenty CRM Environment: Deployed / Verified
Customer Source Adapter: Shadow Verified
EA Runtime Activation: Not Promoted
CRM Write-back: Engineering Verified / Runtime Disabled
```

Acceptance date: `2026-08-27` (Asia/Shanghai)

## Immutable Inputs

| Item                          | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| CRM release                   | `twentycrm/twenty:v2.35.0`                                         |
| CRM host                      | `116.204.36.83`                                                    |
| CRM private endpoint          | `192.168.0.102:3000`                                               |
| HTTPS administrator endpoint  | `https://crm.demo.linggan.top`                                     |
| Shared ingress                | `116.204.37.89` / `192.168.0.210`                                  |
| Import bundle fingerprint     | `d1474cdfb3ad63c2fe7e0fbc102c5e97444b19fb5276a82b6d253fa8c5311b38` |
| Customer model fingerprint    | `ee11d9f5f529876390fcc42a8e6a57823fbacc1346ebe74d6015ada74dd92d80` |
| Customer contract fingerprint | `89a2fab735aa97398ff1c635cebac0b0a5723f7d2f7f17ce126a9e5b7a78ef22` |

Credentials are stored only on the CRM host with mode `0600`. They are not in
Git, Asset metadata, Binding metadata or Receipts.

## Environment Evidence

- PostgreSQL, Redis, Twenty Server and Twenty Worker recovered after a full
  container restart.
- `/healthz` returned `status=ok` after restart.
- The shared ingress reached Twenty directly over the private VPC endpoint.
- The public HTTPS endpoint returned `200`; TLS is managed by Let's Encrypt.
- The idempotent bootstrap completed twice without duplicate records.
- REST counts after restart:

| Object                  | Count |
| ----------------------- | ----: |
| Customer                |    20 |
| Customer Source Link    |    20 |
| Customer Domain Profile |    20 |
| Customer Suggestion     |    60 |
| Customer Interaction    |     0 |
| Customer Follow-up Task |     0 |

## Browser Evidence

The administrator signed in through `https://crm.demo.linggan.top`. The
workspace is named `Linggan Customer Operations`, and the Twenty navigation
exposed these six governed objects:

- `客户`
- `客户来源映射`
- `客户领域画像`
- `客户洞察建议`
- `客户互动`
- `客户跟进任务`

The customer list rendered `20` rows and exposed the Global Customer ID,
source tenant, owner ID and business-data timestamp. Public access to port
`3000` remains closed; administrator access terminates TLS on the shared Nginx
ingress and reaches CRM only through the private VPC.

## Runtime Shadow Evidence

The environment verifier loaded one auto-insurance and one life-insurance
record through the Twenty REST client and the EA normalization adapter.

| Check                                    | Result                   |
| ---------------------------------------- | ------------------------ |
| Auto insurance schema                    | `auto-insurance.v1` PASS |
| Life insurance schema                    | `life-insurance.v1` PASS |
| Auto projected fields                    | 24                       |
| Life projected fields                    | 20                       |
| Field-level provenance                   | PASS                     |
| Cross-profile leakage                    | 0                        |
| Unconfirmed suggestion leakage           | 0                        |
| Broad vehicle purchase-price leakage     | 0                        |
| Missing authorization vs missing subject | Explicitly distinguished |

`productionActivated=false` remains a hard assertion in the verifier.

## Boundaries And Remaining Work

1. Only insurance Demo records are in Twenty. Wealth customer records remain
   on their existing source path until a stable identity crosswalk and field
   authority reconciliation are completed.
2. The current EA Production runtime has not been switched to Twenty.
3. The 121-row wealth workbook defines fields, not customer records. It is an
   input to schema and authority design, not a bulk customer import.
4. Customer interaction and follow-up task objects and confirmation-gated
   write-back contracts are present, but no EA Runtime tool is enabled to write
   them in this Shadow phase.
5. Promotion requires a persistent secret reference, wealth and insurance
   Shadow Diff, purpose/field isolation tests and a separate review.
6. The isolated bootstrap currently uses a Twenty administrator API key. A
   dedicated least-privilege integration role/key is required before Runtime
   activation.
