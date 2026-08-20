CREATE TABLE IF NOT EXISTS `context_source_binding_promotions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `promotion_id` varchar(128) NOT NULL,
  `organization_id` varchar(128) NOT NULL,
  `role_pack_id` varchar(128) NOT NULL,
  `verified_release_id` varchar(128) NOT NULL,
  `previous_snapshot_json` json NOT NULL,
  `promoted_snapshot_json` json NOT NULL,
  `status` enum('active','rolled_back') NOT NULL DEFAULT 'active',
  `created_by` varchar(128) NOT NULL,
  `rolled_back_by` varchar(128) DEFAULT NULL,
  `rolled_back_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_context_source_binding_promotions_public_id` (`promotion_id`),
  KEY `idx_context_source_binding_promotions_role_created` (`organization_id`,`role_pack_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
