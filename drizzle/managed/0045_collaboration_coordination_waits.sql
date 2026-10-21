ALTER TABLE `collaboration_waits` MODIFY COLUMN `resource_kind` enum('request','draft','meeting','reschedule','cascade','coordination') NOT NULL;
--> statement-breakpoint
ALTER TABLE `collaboration_runs` ADD COLUMN `authorization_snapshot_id` varchar(64) NULL;
