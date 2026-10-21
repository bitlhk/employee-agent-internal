ALTER TABLE `collaboration_waits` ADD COLUMN `polled_at` timestamp NULL;
--> statement-breakpoint
CREATE INDEX `idx_collab_wait_poll` ON `collaboration_waits` (`polled_at`);
