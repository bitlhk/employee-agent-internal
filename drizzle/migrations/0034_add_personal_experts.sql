ALTER TABLE `business_agents`
  ADD COLUMN `visibility` ENUM('platform','personal') NOT NULL DEFAULT 'platform' AFTER `kind`,
  ADD COLUMN `owner_user_id` INT NULL AFTER `visibility`,
  ADD COLUMN `owner_adopt_id` VARCHAR(64) NULL AFTER `owner_user_id`,
  ADD COLUMN `endpoint_digest` VARCHAR(64) NULL AFTER `api_url`,
  ADD COLUMN `deleted_at` TIMESTAMP NULL AFTER `endpoint_config_json`,
  ADD KEY `idx_business_agents_owner` (`visibility`, `owner_user_id`, `owner_adopt_id`, `enabled`),
  ADD UNIQUE KEY `uk_business_agents_personal_endpoint` (`owner_adopt_id`, `endpoint_digest`);
