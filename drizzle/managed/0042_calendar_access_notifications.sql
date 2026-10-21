ALTER TABLE `calendar_bindings` ADD COLUMN `grant_id` varchar(64) NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE TABLE `calendar_notifications` (
 `id` varchar(64) PRIMARY KEY, `user_id` int NOT NULL, `event_key` varchar(64) NOT NULL,
 `title` varchar(200) NOT NULL, `start_at` timestamp NOT NULL, `end_at` timestamp NOT NULL,
 `read_at` timestamp NULL, `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY `uk_calendar_notice_event` (`user_id`, `event_key`)
);
--> statement-breakpoint
CREATE TABLE `calendar_coop_links` (
 `id` varchar(64) PRIMARY KEY, `session_id` varchar(64) NOT NULL, `coordination_id` varchar(64) NOT NULL,
 `user_id` int NOT NULL, `last_hash` varchar(64) NOT NULL,
 `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
