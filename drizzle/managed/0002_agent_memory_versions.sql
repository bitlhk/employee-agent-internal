CREATE TABLE IF NOT EXISTS `agent_memory_versions` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `memory_id` bigint NOT NULL,
  `user_id` int NOT NULL,
  `adopt_id` varchar(64) NOT NULL,
  `version` int NOT NULL,
  `kind` enum('preference','instruction','entity','procedure') NOT NULL,
  `content` text NOT NULL,
  `source` enum('explicit','automatic','feedback','legacy') NOT NULL,
  `confidence` int NOT NULL DEFAULT 50,
  `change_type` enum('created','observed','edited','restored') NOT NULL DEFAULT 'observed',
  `valid_from` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `valid_to` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `agent_memory_versions_id` PRIMARY KEY(`id`),
  CONSTRAINT `uk_agent_memory_version` UNIQUE(`memory_id`,`version`),
  INDEX `idx_agent_memory_version_item` (`adopt_id`,`memory_id`,`version`),
  INDEX `idx_agent_memory_version_user` (`user_id`,`created_at`)
);
--> statement-breakpoint
INSERT IGNORE INTO `agent_memory_versions` (
  `memory_id`, `user_id`, `adopt_id`, `version`, `kind`, `content`, `source`,
  `confidence`, `change_type`, `valid_from`, `created_at`
)
SELECT
  `id`, `user_id`, `adopt_id`, `version`, `kind`, `content`, `source`,
  `confidence`, 'created', `created_at`, `created_at`
FROM `agent_memory_items`;
