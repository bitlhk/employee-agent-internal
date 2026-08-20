ALTER TABLE `runtime_agent_bindings`
  ADD COLUMN `desired_asset_revision` int NOT NULL DEFAULT 1 AFTER `asset_set_fingerprint`,
  ADD COLUMN `published_asset_revision` int NOT NULL DEFAULT 1 AFTER `desired_asset_revision`,
  ADD COLUMN `asset_dirty_at` timestamp NULL AFTER `published_asset_revision`;
