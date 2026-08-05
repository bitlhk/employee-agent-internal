ALTER TABLE `agent_tasks`
  ADD COLUMN `lease_owner` varchar(160) NULL AFTER `interaction_answered_at`,
  ADD COLUMN `lease_expires_at` timestamp NULL AFTER `lease_owner`,
  ADD COLUMN `last_heartbeat_at` timestamp NULL AFTER `lease_expires_at`,
  ADD COLUMN `attempt_count` int NOT NULL DEFAULT 0 AFTER `last_heartbeat_at`,
  ADD INDEX `idx_agent_tasks_lease_expiry` (`status`, `lease_expires_at`);
--> statement-breakpoint

CREATE TABLE `chat_skill_session_state` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `adopt_id` varchar(64) NOT NULL,
  `session_id` varchar(160) NOT NULL,
  `skill_id` varchar(128) NOT NULL,
  `selection_mode` enum('manual','automatic') NOT NULL,
  `use_count` int NOT NULL DEFAULT 1,
  `first_selected_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_selected_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_chat_skill_session_state` (`adopt_id`, `session_id`, `skill_id`),
  KEY `idx_chat_skill_session_recent` (`adopt_id`, `session_id`, `last_selected_at`)
);
