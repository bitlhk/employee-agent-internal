ALTER TABLE `calendar_reschedules` ADD COLUMN `cascade_id` varchar(36) NULL;
--> statement-breakpoint
CREATE TABLE `collaboration_runs` (
 `id` varchar(36) PRIMARY KEY, `adopt_id` varchar(64) NOT NULL, `user_id` int NOT NULL,
 `kind` enum('recipient','goal') NOT NULL, `task_type` varchar(64) NOT NULL DEFAULT 'general', `request_id` bigint NULL, `request_key` varchar(36) NULL,
 `parent_run_id` varchar(36) NULL, `budget_root_id` varchar(36) NOT NULL,
 `source_session_id` varchar(160) NULL, `source_conversation_id` varchar(160) NULL,
 `objective` text NOT NULL, `expected_effect` enum('read','calendar_write') NOT NULL DEFAULT 'read',
 `status` enum('ready','running','waiting','waiting_user','completed','failed','cancelled') NOT NULL DEFAULT 'ready',
 `checkpoint` text NULL, `wake_requested` boolean NOT NULL DEFAULT false, `public_message` text NULL,
 `turn` int NOT NULL DEFAULT 0, `depth` int NOT NULL DEFAULT 0, `request_count` int NOT NULL DEFAULT 0,
 `lease_token` varchar(64) NULL, `lease_until` timestamp NULL,
 `available_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, `deadline` timestamp NOT NULL,
 `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY `uk_collab_run_request` (`request_id`), UNIQUE KEY `uk_collab_run_key` (`adopt_id`,`request_key`),
 KEY `idx_collab_run_ready` (`status`,`available_at`)
);
--> statement-breakpoint
CREATE TABLE `collaboration_waits` (
 `run_id` varchar(36) NOT NULL, `resource_kind` enum('request','draft','meeting','reschedule','cascade') NOT NULL,
 `resource_id` varchar(64) NOT NULL, `observed_state` varchar(128) NOT NULL,
 `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY `uk_collab_wait_resource` (`run_id`,`resource_kind`,`resource_id`)
);
--> statement-breakpoint
CREATE TABLE `calendar_cascades` (
 `id` varchar(36) PRIMARY KEY, `user_id` int NOT NULL, `request_key` varchar(36) NOT NULL,
 `title` varchar(200) NOT NULL, `input_hash` varchar(64) NOT NULL, `plan_hash` varchar(64) NOT NULL,
 `steps` json NOT NULL,
 `status` enum('drafting','pending','confirmed','running','waiting','completed','partial','compensating','compensated','cancelled','failed') NOT NULL DEFAULT 'drafting',
 `stop_requested` boolean NOT NULL DEFAULT false, `error_code` varchar(64) NULL,
 `confirmed_at` timestamp NULL, `compensation_confirmed_at` timestamp NULL,
 `lease_token` varchar(64) NULL, `lease_until` timestamp NULL, `expires_at` timestamp NOT NULL,
 `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
 `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY `uk_calendar_cascade_key` (`user_id`,`request_key`)
);
