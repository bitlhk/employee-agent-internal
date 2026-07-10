-- Review-only SQL for role_tag canonicalization.
-- This file is intentionally SELECT-only. Do not add UPDATE statements here.
--
-- The role template source of truth is docs/design/role-skill-mcp-baseline.json.
-- role_tag is secondary metadata for marketplace chips and reverse lookup.

SELECT
  `id`,
  `skill_id`,
  `name`,
  `role_tag`,
  `origin`,
  `status`,
  `author`,
  `provider`,
  CASE
    WHEN `skill_id` = 'credential-prompt-generator' THEN 'credential-compliance'
    WHEN `skill_id` = 'goldencoach-stage-evaluation' THEN 'insurance-advisor'
    WHEN `skill_id` = 'business-monitor' THEN 'business-review'
    WHEN `skill_id` = 'kyc-doc-parse' THEN 'credential-compliance'
    WHEN `skill_id` = 'review-checklist' THEN 'business-review'
    WHEN `skill_id` = 'health-verification' THEN 'insurance-advisor'
    WHEN `skill_id` = 'insurance-claim-fraud-detection' THEN 'credential-compliance'
    ELSE 'TBD'
  END AS `suggested_role_tag`
FROM `skill_marketplace`
WHERE `role_tag` IN (
  'compliance',
  'sales-coaching',
  'risk-management',
  'insurance-underwriting',
  'insurance-claims'
)
ORDER BY `role_tag`, `id`;

-- After manual review, create a separate apply migration that:
-- 1. backs up affected rows into skill_marketplace_role_tag_backup_YYYYMMDD;
-- 2. updates by exact skill_id, not by broad old role_tag;
-- 3. keeps insurance-claims / insurance-underwriting as scenarios only, not
--    first-phase role keys.
