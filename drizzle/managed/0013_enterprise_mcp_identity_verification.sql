ALTER TABLE `enterprise_mcp_connections`
  ADD COLUMN `identity_verification_status` enum('unknown','verified','failed') NOT NULL DEFAULT 'unknown' AFTER `health_status`,
  ADD COLUMN `identity_verification_error` text NULL AFTER `identity_verification_status`,
  ADD COLUMN `identity_verified_at` timestamp NULL AFTER `identity_verification_error`,
  ADD KEY `idx_enterprise_mcp_identity_verification` (`identity_verification_status`, `identity_verified_at`);
