ALTER TABLE `calendar_coordinations` ADD COLUMN `exclude_meeting_id` varchar(64) NULL;
--> statement-breakpoint
ALTER TABLE `calendar_availability_tasks` ADD COLUMN `manual_only` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE `calendar_reschedules` (
 `id` varchar(64) PRIMARY KEY, `meeting_id` varchar(64) NOT NULL, `user_id` int NOT NULL,
 `previous` json NOT NULL, `payload` json NOT NULL, `version` varchar(256) NOT NULL,
 `binding_fingerprint` varchar(64) NOT NULL, `check_coordination_id` varchar(64) NULL,
 `status` enum('pending','checking','executing','completed','unknown','cancelled') NOT NULL DEFAULT 'pending',
 `expires_at` timestamp NOT NULL, `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY `idx_calendar_reschedules_owner` (`user_id`)
);
--> statement-breakpoint
CREATE TABLE `calendar_chat_turns` (
 `id` varchar(64) PRIMARY KEY, `user_id` int NOT NULL, `input_hash` varchar(64) NOT NULL,
 `transcript` json NOT NULL, `status` enum('running','completed') NOT NULL DEFAULT 'running',
 `reply` text NULL, `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY `idx_calendar_chat_owner` (`user_id`)
);
