ALTER TABLE `agent_memory_items`
  ADD COLUMN `organization_id` varchar(128) NULL AFTER `role_template`,
  ADD COLUMN `visibility_class` enum('principal_private','role_private','enterprise_shared') NOT NULL DEFAULT 'principal_private' AFTER `organization_id`,
  ADD COLUMN `purpose_scope_json` json NULL AFTER `visibility_class`,
  ADD COLUMN `purpose_scope_version` varchar(32) NOT NULL DEFAULT '1' AFTER `purpose_scope_json`,
  ADD COLUMN `subject_id` varchar(128) NULL AFTER `purpose_scope_version`,
  ADD COLUMN `scope_provenance_json` json NULL AFTER `subject_id`;
--> statement-breakpoint
CREATE INDEX `idx_agent_memory_purpose_scope`
  ON `agent_memory_items` (`organization_id`, `visibility_class`, `role_template`, `status`);
--> statement-breakpoint
ALTER TABLE `governed_work_items`
  ADD COLUMN `visibility_class` enum('principal_private','role_private','enterprise_shared') NOT NULL DEFAULT 'principal_private' AFTER `role_template`,
  ADD COLUMN `purpose_scope_json` json NULL AFTER `visibility_class`,
  ADD COLUMN `purpose_scope_version` varchar(32) NOT NULL DEFAULT '1' AFTER `purpose_scope_json`,
  ADD COLUMN `subject_id` varchar(128) NULL AFTER `purpose_scope_version`,
  ADD COLUMN `scope_provenance_json` json NULL AFTER `subject_id`;
--> statement-breakpoint
CREATE INDEX `idx_governed_work_item_purpose_scope`
  ON `governed_work_items` (`organization_id`, `visibility_class`, `role_template`, `status`);
