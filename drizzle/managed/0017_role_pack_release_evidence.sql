CREATE TABLE IF NOT EXISTS `role_pack_releases` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `release_id` varchar(128) NOT NULL,
  `role_pack_id` varchar(128) NOT NULL,
  `eval_suite_version` varchar(64) NOT NULL,
  `asset_set_fingerprint` varchar(64) NOT NULL,
  `verification_level` enum('contract','controlled_scenario','model_scenario') NOT NULL,
  `status` enum('candidate','verified','stale','failed') NOT NULL DEFAULT 'candidate',
  `contract_report` json NOT NULL,
  `scenario_report` json NULL,
  `verified_at` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_role_pack_releases_public_id` (`release_id`),
  UNIQUE KEY `uk_role_pack_releases_asset_suite` (`role_pack_id`,`eval_suite_version`,`asset_set_fingerprint`),
  KEY `idx_role_pack_releases_role_status` (`role_pack_id`,`status`,`verified_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
