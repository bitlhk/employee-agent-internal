ALTER TABLE `custom_mcp_connections`
  MODIFY COLUMN `auth_type` ENUM('none','bearer','api_key','oauth') NOT NULL DEFAULT 'none',
  ADD COLUMN `catalog_id` VARCHAR(64) NULL AFTER `credential_encrypted`,
  ADD COLUMN `oauth_data_encrypted` TEXT NULL AFTER `catalog_id`,
  ADD KEY `idx_custom_mcp_catalog` (`user_id`, `adopt_id`, `catalog_id`);
