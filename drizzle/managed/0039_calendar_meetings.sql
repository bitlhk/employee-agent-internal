ALTER TABLE `calendar_bindings` ADD COLUMN `calendar_email` varchar(320) NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `calendar_meetings` (
  `id` varchar(64) NOT NULL, `coordination_id` varchar(64) NOT NULL,
  `creator_user_id` int NOT NULL, `payload` json NOT NULL, `payload_hash` varchar(64) NOT NULL,
  `binding_fingerprint` varchar(64) NOT NULL, `check_coordination_id` varchar(64) NULL,
  `status` enum('pending','checking','creating','invited','unknown','cancelled') NOT NULL DEFAULT 'pending',
  `expires_at` timestamp NOT NULL, `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_calendar_meetings_coordination` (`coordination_id`)
);
