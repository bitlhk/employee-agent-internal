CREATE TABLE IF NOT EXISTS `agent_memory_conflicts` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `memory_id` bigint NOT NULL,
  `user_id` int NOT NULL,
  `adopt_id` varchar(64) NOT NULL,
  `proposed_kind` enum('preference','instruction','entity','procedure') NOT NULL,
  `proposed_content` text NOT NULL,
  `proposed_hash` varchar(64) NOT NULL,
  `proposed_source` enum('explicit','automatic','feedback','legacy') NOT NULL DEFAULT 'automatic',
  `proposed_confidence` int NOT NULL DEFAULT 50,
  `evidence_count` int NOT NULL DEFAULT 0,
  `status` enum('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  `first_observed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_observed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `resolved_at` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `agent_memory_conflicts_id` PRIMARY KEY(`id`),
  INDEX `idx_agent_memory_conflict_item` (`memory_id`,`status`,`updated_at`),
  INDEX `idx_agent_memory_conflict_adopt` (`adopt_id`,`status`,`updated_at`),
  INDEX `idx_agent_memory_conflict_hash` (`memory_id`,`proposed_hash`)
);
--> statement-breakpoint
ALTER TABLE `agent_memory_evidence`
  ADD COLUMN `conflict_id` bigint NULL AFTER `memory_id`,
  ADD INDEX `idx_agent_memory_evidence_conflict` (`conflict_id`,`observed_at`);
--> statement-breakpoint
ALTER TABLE `agent_tasks`
  ADD COLUMN `request_context_json` text NULL AFTER `input`;
