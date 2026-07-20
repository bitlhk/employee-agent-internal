CREATE TABLE IF NOT EXISTS `agent_mcp_preferences` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `adopt_id` VARCHAR(64) NOT NULL,
  `server_id` VARCHAR(128) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `updated_by` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_agent_mcp_preferences_scope` (`adopt_id`, `server_id`),
  KEY `idx_agent_mcp_preferences_adopt` (`adopt_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
