ALTER TABLE `claw_collab_requests` ADD COLUMN `requestKey` varchar(36) NULL;
--> statement-breakpoint
ALTER TABLE `claw_collab_requests` ADD COLUMN `requestFingerprint` varchar(64) NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `uk_collab_requester_key` ON `claw_collab_requests` (`requesterAdoptId`, `requestKey`);
