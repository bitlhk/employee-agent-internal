ALTER TABLE `enterprise_asset_candidates`
  ADD COLUMN `discovery_json` json NULL AFTER `suggested_metadata_json`,
  ADD COLUMN `diagnostics_json` json NULL AFTER `discovery_json`;
