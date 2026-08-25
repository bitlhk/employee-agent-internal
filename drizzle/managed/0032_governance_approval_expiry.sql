ALTER TABLE `governance_approvals`
  MODIFY COLUMN `expires_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
