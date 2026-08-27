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

| Item                           | Value                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| CRM release                    | `twentycrm/twenty:v2.35.0`                                         |
| CRM host                       | `116.204.36.83`                                                    |
| CRM private endpoint           | `192.168.0.102:3000`                                               |
| HTTPS administrator endpoint   | `https://crm.demo.linggan.top`                                     |
| Shared ingress                 | `116.204.37.89` / `192.168.0.210`                                  |
| Import bundle fingerprint      | `787af97ec05b3404ea594c0e7e1f57c90f36e6e62e2ea0c14bc71fa0e9fdf517` |
| Wealth MCP export fingerprint  | `dfaa828cd05f5a38f836fc07bf6b3c4e8860c87d4649ac6562c21a09cd80a878` |
| Identity Crosswalk fingerprint | `43288a2cc01348a0695c5b0557c85e54a2592337b71606b27f32ac715c02ff43` |
| Customer model fingerprint     | `da09eb5e35af1fdd57689b1fca17903323484c006611e79f8206cb794e478424` |
| Customer contract fingerprint  | `b9fffc9d3017390301d049befbf43639e4d55e606e03fdc5eff227bacc525521` |

Credentials are stored only on the CRM host with mode `0600`. They are not in
Git, Asset metadata, Binding metadata or Receipts.

## Environment Evidence

- PostgreSQL, Redis, Twenty Server and Twenty Worker recovered after a full
  container restart.
- `/healthz` returned `status=ok` after restart.
- The shared ingress reached Twenty directly over the private VPC endpoint.
- The public HTTPS endpoint returned `200`; TLS is managed by Let's Encrypt.
- The idempotent bootstrap completed twice without duplicate records.
- The pre-migration PostgreSQL and REST snapshot is stored at
  `/root/backups/linggan-customer-crm/20260827T104449Z` on the CRM host.
- The previous integration key was revoked. The active import actor is
  `灵感数据管理员`.
- REST counts after restart:

| Object                  | Count |
| ----------------------- | ----: |
| Customer                |    28 |
| Customer Source Link    |    28 |
| Customer Domain Profile |    28 |
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

The customer list rendered `28` rows: `8` wealth customers, `10` auto-insurance
customers and `10` life-insurance customers. Global IDs use `CUST-xxxxxx`, and
Created by / Updated by resolve to `灵感数据管理员`; no `DEMO-INS` identifier is
shown. Public access to port `3000` remains closed; administrator access
terminates TLS on the shared Nginx ingress and reaches CRM only through the
private VPC.

## Runtime Shadow Evidence

The environment verifier loaded one wealth, one auto-insurance and one
life-insurance record through the Twenty REST client and the EA normalization
adapter.

| Check                                    | Result                   |
| ---------------------------------------- | ------------------------ |
| Wealth schema                            | `wealth.v1` PASS         |
| Auto insurance schema                    | `auto-insurance.v1` PASS |
| Life insurance schema                    | `life-insurance.v1` PASS |
| Wealth projected fields                  | 16                       |
| Auto projected fields                    | 24                       |
| Life projected fields                    | 20                       |
| Field-level provenance                   | PASS                     |
| Cross-profile leakage                    | 0                        |
| Unconfirmed suggestion leakage           | 0                        |
| Broad vehicle purchase-price leakage     | 0                        |
| Missing authorization vs missing subject | Explicitly distinguished |

`productionActivated=false` remains a hard assertion in the verifier.

## Boundaries And Remaining Work

1. Twenty contains 20 insurance Demo records and 8 wealth records read through
   the governed Shanghai `customer_context` MCP path. The explicit Crosswalk
   creates stable global IDs; no name, phone or model-based merge is allowed.
2. The current EA Production runtime has not been switched to Twenty.
3. The 121-row wealth workbook defines fields, not customer records. It is an
   input to schema and authority design, not 121 populated CRM columns.
4. Customer interaction and follow-up task objects and confirmation-gated
   write-back contracts are present, but no EA Runtime tool is enabled to write
   them in this Shadow phase.
5. Promotion requires a persistent secret reference, wealth and insurance
   Shadow Diff, purpose/field isolation tests and a separate review.
6. The bootstrap currently uses a Twenty administrator API key. A
   dedicated least-privilege integration role/key is required before Runtime
   activation.
