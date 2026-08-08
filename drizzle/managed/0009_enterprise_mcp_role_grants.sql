INSERT INTO `role_asset_grants` (
  `role_key`, `asset_type`, `asset_id`, `grant_mode`, `source`, `enabled`, `created_by`, `updated_by`
) VALUES
  ('insurance-advisor', 'mcp_server', 'insurance_customer_profile', 'default', 'admin', true, 'managed-migration', 'managed-migration'),
  ('insurance-advisor', 'mcp_server', 'insurance_product_exam_points', 'default', 'admin', true, 'managed-migration', 'managed-migration')
ON DUPLICATE KEY UPDATE
  `grant_mode` = VALUES(`grant_mode`),
  `enabled` = true,
  `updated_by` = 'managed-migration';
