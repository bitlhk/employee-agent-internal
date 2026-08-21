CREATE TABLE IF NOT EXISTS `enterprise_asset_source_runs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `run_id` varchar(64) NOT NULL,
  `source_id` varchar(128) NOT NULL,
  `active_run_key` varchar(128) NULL,
  `scan_mode` enum('full','incremental') NOT NULL,
  `status` enum('running','succeeded','partial','failed') NOT NULL DEFAULT 'running',
  `scan_complete` boolean NOT NULL DEFAULT false,
  `cursor_before` varchar(1000) NULL,
  `cursor_after` varchar(1000) NULL,
  `resume_of_run_id` varchar(64) NULL,
  `attempt` int NOT NULL DEFAULT 1,
  `discovered_count` int NOT NULL DEFAULT 0,
  `created_count` int NOT NULL DEFAULT 0,
  `changed_count` int NOT NULL DEFAULT 0,
  `unchanged_count` int NOT NULL DEFAULT 0,
  `missing_count` int NOT NULL DEFAULT 0,
  `failed_count` int NOT NULL DEFAULT 0,
  `error_json` json NULL,
  `started_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at` timestamp NULL,
  `created_by` varchar(128) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_enterprise_asset_source_runs_public_id` (`run_id`),
  UNIQUE KEY `uk_enterprise_asset_source_runs_active` (`active_run_key`),
  KEY `idx_enterprise_asset_source_runs_source_status` (`source_id`,`status`,`started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `enterprise_asset_source_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `source_item_id` varchar(64) NOT NULL,
  `source_id` varchar(128) NOT NULL,
  `external_item_id` varchar(512) NOT NULL,
  `enterprise_asset_id` varchar(128) NOT NULL,
  `relative_path` varchar(700) NOT NULL,
  `source_uri` varchar(1000) NULL,
  `etag` varchar(256) NULL,
  `source_modified_at` timestamp NULL,
  `content_hash` varchar(64) NOT NULL,
  `latest_source_version` varchar(64) NULL,
  `size_bytes` bigint unsigned NOT NULL DEFAULT 0,
  `state` enum('active','missing','retired') NOT NULL DEFAULT 'active',
  `last_seen_run_id` varchar(64) NOT NULL,
  `missing_since_run_id` varchar(64) NULL,
  `latest_candidate_id` varchar(64) NULL,
  `first_seen_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_enterprise_asset_source_items_public_id` (`source_item_id`),
  UNIQUE KEY `uk_enterprise_asset_source_items_external` (`source_id`,`external_item_id`),
  KEY `idx_enterprise_asset_source_items_source_state` (`source_id`,`state`,`last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

ALTER TABLE `enterprise_asset_candidates`
  ADD COLUMN `sync_run_id` varchar(64) NULL AFTER `source_id`,
  ADD COLUMN `source_item_id` varchar(64) NULL AFTER `sync_run_id`,
  ADD KEY `idx_enterprise_asset_candidates_sync_run` (`sync_run_id`,`source_item_id`);
