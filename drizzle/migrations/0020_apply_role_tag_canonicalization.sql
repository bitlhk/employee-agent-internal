-- Apply role_tag canonicalization by exact skill_id.
--
-- role_tag is marketplace display / reverse lookup metadata only. Runtime
-- authorization is resolved from role_asset_grants.
--
-- This migration is intentionally exact-id based. Do not update by broad old
-- role_tag because the same old tag can contain multiple business meanings.

CREATE TABLE IF NOT EXISTS `skill_marketplace_role_tag_backup_20260618` AS
SELECT
  `id`,
  `skill_id`,
  `name`,
  `role_tag`,
  `origin`,
  `status`,
  `author`,
  `provider`,
  NOW() AS `backed_up_at`
FROM `skill_marketplace`
WHERE `skill_id` IN (
  'credential-prompt-generator',
  'goldencoach-stage-evaluation',
  'insurance-claim-fraud-detection',
  'health-verification',
  'business-monitor',
  'kyc-doc-parse',
  'review-checklist'
);

UPDATE `skill_marketplace`
SET `role_tag` = CASE `skill_id`
  WHEN 'credential-prompt-generator' THEN 'credential-compliance'
  WHEN 'goldencoach-stage-evaluation' THEN 'insurance-advisor'
  WHEN 'insurance-claim-fraud-detection' THEN 'credential-compliance'
  WHEN 'health-verification' THEN 'insurance-advisor'
  WHEN 'business-monitor' THEN 'business-review'
  WHEN 'kyc-doc-parse' THEN 'credential-compliance'
  WHEN 'review-checklist' THEN 'business-review'
  ELSE `role_tag`
END
WHERE `skill_id` IN (
  'credential-prompt-generator',
  'goldencoach-stage-evaluation',
  'insurance-claim-fraud-detection',
  'health-verification',
  'business-monitor',
  'kyc-doc-parse',
  'review-checklist'
);
