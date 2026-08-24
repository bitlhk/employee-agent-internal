ALTER TABLE `context_source_bindings`
  ADD COLUMN `binding_scope` enum('role_pack','enterprise_shared') NOT NULL DEFAULT 'role_pack' AFTER `role_pack_id`;
--> statement-breakpoint
CREATE INDEX `idx_context_source_bindings_scope_stage_status`
  ON `context_source_bindings` (`organization_id`, `binding_scope`, `stage`, `status`);
--> statement-breakpoint
ALTER TABLE `context_source_binding_promotions`
  ADD COLUMN `validation_evidence_json` json NULL AFTER `promoted_snapshot_json`;
