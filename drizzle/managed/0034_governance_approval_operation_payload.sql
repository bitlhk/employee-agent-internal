ALTER TABLE `governance_approvals`
  ADD COLUMN `operation_payload_json` json NULL AFTER `payload_hash`;
