ALTER TABLE `enterprise_asset_candidates`
  ADD COLUMN `projection_decision` enum('pending','searchable_only','runtime_candidate','archived') NOT NULL DEFAULT 'pending' AFTER `target_asset_id`,
  ADD COLUMN `projection_reason` varchar(1000) NULL AFTER `projection_decision`,
  ADD COLUMN `projection_decided_by` varchar(128) NULL AFTER `projection_reason`,
  ADD COLUMN `projection_decided_at` timestamp NULL AFTER `projection_decided_by`,
  ADD KEY `idx_enterprise_asset_candidates_projection` (`projection_decision`,`status`);
--> statement-breakpoint

UPDATE `enterprise_asset_candidates`
SET `projection_decision` = 'runtime_candidate',
    `projection_reason` = COALESCE(`projection_reason`, 'Existing published Runtime knowledge projection'),
    `projection_decided_by` = COALESCE(`projection_decided_by`, `published_by`, `updated_by`),
    `projection_decided_at` = COALESCE(`projection_decided_at`, `published_at`, `updated_at`)
WHERE `asset_type` = 'knowledge_document'
  AND `status` IN ('published','stale')
  AND `target_asset_type` = 'knowledge_document'
  AND `target_asset_id` IS NOT NULL;
--> statement-breakpoint

UPDATE `enterprise_asset_candidates`
SET `projection_decision` = 'archived',
    `projection_reason` = COALESCE(`projection_reason`, 'Asset lifecycle is archived; no Runtime projection'),
    `projection_decided_by` = COALESCE(`projection_decided_by`, `reviewed_by`, `updated_by`),
    `projection_decided_at` = COALESCE(`projection_decided_at`, `reviewed_at`, `updated_at`)
WHERE `asset_type` = 'knowledge_document'
  AND `status` = 'approved'
  AND JSON_UNQUOTE(JSON_EXTRACT(`confirmed_metadata_json`, '$.lifecycle')) = 'archived';
