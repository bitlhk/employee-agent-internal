# GRACE Customer CRM Environment Acceptance V1

## Result

```text
Twenty CRM Environment: Deployed / Verified
Customer Source Adapter: Environment Verified / Production Ready
Customer Domain Profiles: 40 Active
Local EA Runtime: Customer Context Active
Shanghai EA Runtime: Customer Context Active
CRM Follow-up Write-back: Local + Shanghai Agent E2E Verified
```

Acceptance date: `2026-08-28` (Asia/Shanghai)

## Immutable Inputs

| Item                            | Value                                                              |
| ------------------------------- | ------------------------------------------------------------------ |
| CRM release                     | `twentycrm/twenty:v2.35.0`                                         |
| CRM host                        | `116.204.36.83`                                                    |
| CRM private endpoint            | `192.168.0.102:3000`                                               |
| HTTPS administrator endpoint    | `https://crm.demo.linggan.top`                                     |
| Shared ingress                  | `116.204.37.89` / `192.168.0.210`                                  |
| Import bundle fingerprint       | `65f5611dc19a88224442ba82cb23ecba1c67776a8d129564eef1b4a0c1a587fa` |
| Wealth MCP export fingerprint   | `dfaa828cd05f5a38f836fc07bf6b3c4e8860c87d4649ac6562c21a09cd80a878` |
| Identity Crosswalk fingerprint  | `43288a2cc01348a0695c5b0557c85e54a2592337b71606b27f32ac715c02ff43` |
| Customer model V2 fingerprint   | `af37e5045d7bf37e7fd7e732800797afa6c98bb58ad3390735f85dd91775dfee` |
| Manual ID allocator fingerprint | `a22ef37b5eb28f31eaaf5273eebdd79d0f9ea7d574e7cfa11ba5ec925a247983` |
| Customer contract fingerprint   | `c951d077d54c43985678fe34efc8b17b2ef292ef674d0571e00e7a9f6ec219d1` |
| Source mapping fingerprint      | `3faf56067e713516d35e3ae637a02205c6bec6525aa8ce74b740c86d37151d0f` |

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
| Customer                |    34 |
| Customer Assignment     |     8 |
| Customer Source Link    |    28 |
| Customer Domain Profile |    40 |
| Customer Suggestion     |    60 |
| Customer Interaction    |     0 |
| Customer Follow-up Task |     7 |

## Browser Evidence

The administrator signed in through `https://crm.demo.linggan.top`. The
workspace is named `Linggan Customer Operations`, and the Twenty navigation
exposed these seven governed objects:

- `客户`
- `客户分配`
- `客户来源映射`
- `客户领域画像`
- `客户洞察建议`
- `客户互动`
- `客户跟进任务`

The customer list renders `34` rows. The profile layer contains `14` wealth,
`13` auto-insurance and `13` life-insurance profiles, including six restricted
customers with both wealth and insurance profiles. Global IDs use
`CUST-xxxxxx`, and
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

The 40 domain profiles were promoted through the explicit profile Promotion
command. A repeated idempotent Bootstrap preserved all unchanged `active`
profiles; changed profile content is forced back to `candidate` instead of
silently changing a Runtime fact.

## Direct Customer Context Evidence

The direct Twenty path was exercised with real locally resolved wealth and
insurance Runtime Principals. No legacy customer MCP was called.

| Check             | Wealth manager | Insurance advisor       |
| ----------------- | -------------- | ----------------------- |
| Legacy source ID  | `C005`         | `1`                     |
| Canonical subject | `CUST-000005`  | `CUST-000101`           |
| Directory source  | `twenty_crm`   | `twenty_crm`            |
| Profile source    | `twenty_crm`   | `twenty_crm`            |
| Assurance         | `production`   | `production`            |
| Portfolio source  | `twenty_crm`   | Not exposed by contract |

The application cutover is controlled by
`EA_CUSTOMER_CONTEXT_TWENTY_ENABLED` and
`EA_CUSTOMER_CONTEXT_TWENTY_PRODUCTION_READY`.

Both the local EA Runtime and Shanghai Runtime have completed this cutover. The
legacy customer MCPs remain rollback providers but are not Agent-facing customer
entry points.

## Cross-role Assigned Customer Evidence

The role adoption `lgj-lihongkun` has six restricted customers assigned through
the same `role_adoption` principal. Each customer has one active wealth profile
and one active insurance profile. The EA role and purpose projection determines
which profile is provided; changing roles does not change the assigned customer
set.

| Global customer ID | Customer | Active profiles         |
| ------------------ | -------- | ----------------------- |
| `CUST-000201`      | 周明远   | wealth + life insurance |
| `CUST-000202`      | 沈嘉禾   | wealth + life insurance |
| `CUST-000203`      | 赵婉清   | wealth + auto insurance |
| `CUST-000204`      | 孙志诚   | wealth + life insurance |
| `CUST-000205`      | 郑雅雯   | wealth + auto insurance |
| `CUST-000206`      | 何文博   | wealth + auto insurance |

The Shanghai acceptance command ran the same adoption through the
`wealth-manager` and `insurance-advisor` Runtime principals without changing the
stored production role. Both principals resolved the same six stable customer
IDs and passed write authorization for all six assigned customers.

| Check                           | Result                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| Shared assigned customer set    | PASS (`6/6`)                                                       |
| Assigned-set fingerprint        | `88296b7a1775c336e7d746a8a354731fc831e958a07456327576f325033a6d01` |
| Wealth projection               | Wealth and investment-risk fields only                             |
| Insurance projection            | Coverage, claims-risk and protection-gap fields only               |
| Cross-role field leakage        | `0`                                                                |
| Wealth write authorization      | `6/6 ALLOW`                                                        |
| Insurance write authorization   | `6/6 ALLOW`                                                        |
| Acceptance evidence fingerprint | `cf5a1942f98eaa36fce761315223ed47279751e4a6e85c7a166cb5d942da65e3` |

The fixture bundle fingerprint is
`6c5f67f566d7a4d7870287d8f214b12867243af9dc5fd43832c4bba9d6607668`.
The final local and Shanghai immutable release is
`20260828T051559Z-dc7e2269913c`; the source commit is `dc7e2269`. The validated
Shanghai backup immediately before final acceptance is
`/root/backups/lingxia/20260828-131232`, and the CRM pre-import backup is
`/root/backups/linggan-customer-crm/cross-role-20260828T050255Z`.

## Agent Follow-up Write-back Evidence

The local and Shanghai release `20260828T035902Z-c9b74ac41fa5` enables only the
governed follow-up task operation. Customer interaction write-back remains
outside this V1 Runtime scope. The source commit is `c9b74ac4`; the validated
Shanghai pre-release backup is `/root/backups/lingxia/20260828-120041`.

The Shanghai browser-equivalent Agent flow used the wealth-manager adoption
`lgj-lihongkun` and the explicitly assigned customer `CUST-000201`:

```text
Agent customer lookup
  -> assignment and purpose authorization
  -> create_customer_followup_task
  -> one platform governance confirmation
  -> EA directly executes the bound formal operation after approval
  -> one Twenty follow-up task
  -> Execution Receipt
```

| Check                                        | Result                         |
| -------------------------------------------- | ------------------------------ |
| Official confirmation cards                  | `1`                            |
| Generic `ask_user` confirmations             | `0`                            |
| Approval final state                         | `consumed`                     |
| CRM rows for the idempotency key             | `1`                            |
| Execution Receipt                            | PASS                           |
| Assigned customer write                      | PASS                           |
| Unassigned customer rejected before approval | PASS (`CUSTOMER_NOT_ASSIGNED`) |
| Unassigned customer CRM rows                 | `0`                            |

The accepted Shanghai task was `上海单次确认写入验收`, due at
`2026-09-09T09:00:00+08:00`. Its CRM record retains the stable customer ID,
role-adoption owner, purpose, confirmation actor, idempotency key and execution
receipt ID `crmex_5fcf139df29bd0986c3eacc4b2e41e1ddd08fa98`. A separate
attempt to write the unassigned wealth customer `CUST-000002` was rejected with
`CUSTOMER_NOT_ASSIGNED` before any approval was created. The acceptance record
deliberately excludes session credentials and the Twenty integration secret.

## Manual Create Acceptance

The customer object's native New button is supported. `globalCustomerId` is
read-only in the UI and nullable only at the Twenty API boundary. The database
assigns a reserved `CUST-9xxxxx` identifier atomically before persistence and
defaults the new record to `draft`. Draft records remain outside Runtime until
their source mapping and domain profile pass governance.

Environment verification created `CUST-900001` without supplying an ID,
confirmed `draft` plus the canonical tenant, and then hard-deleted the fixture.
Five concurrent creates then received unique IDs `CUST-900002` through
`CUST-900006`; all five fixtures were hard-deleted.
The post-test customer count remained `28` with zero missing Global Customer
IDs. The pre-change database snapshot is
`/root/backups/linggan-customer-crm/manual-create-20260827T121503Z`.

## Boundaries And Remaining Work

1. Twenty contains the canonical Demo customer source. The explicit Crosswalk
   creates stable global IDs; no name, phone or model-based merge is allowed.
2. The checked-in acceptance state is backed by the local and Shanghai immutable
   deployments and the Shanghai assigned/unassigned write verification above.
3. The 121-row wealth workbook defines fields, not customer records. It is an
   input to schema and authority design, not 121 populated CRM columns.
4. Follow-up task creation is enabled in the verified local and Shanghai EA
   Runtimes and requires assignment, purpose authorization, one platform
   confirmation, idempotency and an Execution Receipt. Customer interaction
   write-back remains disabled.
5. Old wealth and insurance customer MCPs remain rollback providers for one
   release, but must not be exposed to Agent Skills after cutover.
6. The current Demo Runtime uses a separately stored Twenty integration secret.
   A least-privilege Twenty object role remains required before a customer
   production deployment; the Demo environment does not weaken EA row and
   projection authorization to compensate for this gap.
