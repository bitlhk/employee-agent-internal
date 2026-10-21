ALTER TABLE `calendar_bindings` ADD COLUMN `write_enabled` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `calendar_write_drafts` (
  `id` varchar(64) NOT NULL,
  `user_id` int NOT NULL,
  `binding_fingerprint` varchar(64) NOT NULL,
  `payload` json NOT NULL,
  `status` enum('pending','executing','completed','unknown','cancelled') NOT NULL DEFAULT 'pending',
  `expires_at` timestamp NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), KEY `idx_calendar_write_drafts_user` (`user_id`)
);
