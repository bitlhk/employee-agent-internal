ALTER TABLE `calendar_bindings` ADD COLUMN `auto_availability` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `calendar_coordinations` (
  `id` varchar(64) NOT NULL, `creator_user_id` int NOT NULL, `request_key` varchar(64) NOT NULL,
  `payload` json NOT NULL, `payload_hash` varchar(64) NOT NULL,
  `status` enum('collecting','completed','cancelled','expired') NOT NULL DEFAULT 'collecting',
  `expires_at` timestamp NOT NULL, `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_calendar_coordination_request` (`creator_user_id`,`request_key`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `calendar_availability_tasks` (
  `id` varchar(64) NOT NULL, `coordination_id` varchar(64) NOT NULL,
  `target_user_id` int NOT NULL, `display_name` varchar(200) NOT NULL,
  `status` enum('pending','running','replied','declined') NOT NULL DEFAULT 'pending',
  `reply` json NULL, `lease_token` varchar(64) NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_calendar_availability_member` (`coordination_id`,`target_user_id`),
  KEY `idx_calendar_availability_target` (`target_user_id`)
);
