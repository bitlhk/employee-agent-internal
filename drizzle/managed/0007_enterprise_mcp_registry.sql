CREATE TABLE `enterprise_mcp_connections` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `server_id` varchar(128) NOT NULL,
  `display_name` varchar(128) NOT NULL,
  `description` text NULL,
  `icon` varchar(512) NULL,
  `business_domain` varchar(64) NOT NULL,
  `endpoint_url` varchar(2048) NOT NULL,
  `resource_uri` varchar(2048) NOT NULL,
  `protocol_version` enum('2025-11-25','2026-07-28') NOT NULL DEFAULT '2025-11-25',
  `identity_mode` enum('platform','tenant','user') NOT NULL DEFAULT 'platform',
  `auth_mode` enum('oauth2_access_token','static_bearer_legacy','none_shadow') NOT NULL DEFAULT 'none_shadow',
  `credential_encrypted` text NULL,
  `data_classification` enum('public','internal','sensitive','restricted') NOT NULL DEFAULT 'internal',
  `environment` enum('dev','test','prod') NOT NULL DEFAULT 'prod',
  `lifecycle_state` enum('legacy','shadow','enforced','disabled') NOT NULL DEFAULT 'shadow',
  `timeout_ms` int NOT NULL DEFAULT 30000,
  `owner_department` varchar(128) NULL,
  `owner_contact` varchar(256) NULL,
  `health_url` varchar(2048) NULL,
  `health_status` enum('unknown','ready','error') NOT NULL DEFAULT 'unknown',
  `last_error` text NULL,
  `tools_json` json NULL,
  `last_tested_at` timestamp NULL,
  `created_by` varchar(128) NULL,
  `updated_by` varchar(128) NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_enterprise_mcp_server_id` (`server_id`),
  KEY `idx_enterprise_mcp_domain_state` (`business_domain`, `lifecycle_state`),
  KEY `idx_enterprise_mcp_health` (`health_status`, `last_tested_at`)
);
--> statement-breakpoint

CREATE TABLE `enterprise_mcp_tool_policies` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `server_id` varchar(128) NOT NULL,
  `tool_name` varchar(256) NOT NULL,
  `enabled` boolean NOT NULL DEFAULT true,
  `side_effect` enum('read','compute','workspace_write','write','external_send','financial_action','approval_action','admin_action') NOT NULL DEFAULT 'read',
  `required_scopes` json NOT NULL,
  `allowed_roles` json NULL,
  `identity_mode_override` enum('platform','tenant','user') NULL,
  `approval_mode` enum('never','conditional','always') NOT NULL DEFAULT 'never',
  `audit_level` enum('normal','strong','highest') NOT NULL DEFAULT 'normal',
  `idempotency_required` boolean NOT NULL DEFAULT false,
  `argument_policy_json` json NULL,
  `created_by` varchar(128) NULL,
  `updated_by` varchar(128) NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_enterprise_mcp_tool_policy` (`server_id`, `tool_name`),
  KEY `idx_enterprise_mcp_tool_server` (`server_id`, `enabled`),
  KEY `idx_enterprise_mcp_tool_side_effect` (`side_effect`)
);
--> statement-breakpoint

INSERT IGNORE INTO `enterprise_mcp_connections` (
  `server_id`, `display_name`, `description`, `business_domain`, `endpoint_url`, `resource_uri`,
  `protocol_version`, `identity_mode`, `auth_mode`, `data_classification`, `environment`,
  `lifecycle_state`, `timeout_ms`, `owner_department`, `created_by`, `updated_by`
) VALUES
  ('insurance_customer_profile', '客户画像', '查询保险客户画像与客户基础信息。', 'insurance', 'https://mcp.demo.linggan.top/insurance/customer-profile/mcp', 'https://mcp.demo.linggan.top/insurance/customer-profile/mcp', '2025-11-25', 'user', 'none_shadow', 'sensitive', 'prod', 'shadow', 30000, '保险业务团队', 'managed-migration', 'managed-migration'),
  ('insurance_product_exam_points', '产品考点', '查询保险产品、产品详情与培训考点。', 'insurance', 'https://mcp.demo.linggan.top/insurance/product-exam-points/mcp', 'https://mcp.demo.linggan.top/insurance/product-exam-points/mcp', '2025-11-25', 'tenant', 'none_shadow', 'internal', 'prod', 'shadow', 30000, '保险业务团队', 'managed-migration', 'managed-migration');
--> statement-breakpoint

INSERT IGNORE INTO `enterprise_mcp_tool_policies` (`server_id`, `tool_name`, `enabled`, `side_effect`, `required_scopes`, `approval_mode`, `audit_level`, `idempotency_required`, `created_by`, `updated_by`) VALUES
  ('insurance_customer_profile', 'list_customer_profiles', true, 'read', JSON_ARRAY('insurance.customer.read'), 'never', 'strong', false, 'managed-migration', 'managed-migration'),
  ('insurance_customer_profile', 'get_customer_profile_by_name', true, 'read', JSON_ARRAY('insurance.customer.read'), 'never', 'strong', false, 'managed-migration', 'managed-migration'),
  ('insurance_product_exam_points', 'list_products', true, 'read', JSON_ARRAY('insurance.product.read'), 'never', 'normal', false, 'managed-migration', 'managed-migration'),
  ('insurance_product_exam_points', 'search_products', true, 'read', JSON_ARRAY('insurance.product.read'), 'never', 'normal', false, 'managed-migration', 'managed-migration'),
  ('insurance_product_exam_points', 'get_product_detail', true, 'read', JSON_ARRAY('insurance.product.read'), 'never', 'normal', false, 'managed-migration', 'managed-migration'),
  ('insurance_product_exam_points', 'get_exam_points', true, 'read', JSON_ARRAY('insurance.product.read'), 'never', 'normal', false, 'managed-migration', 'managed-migration'),
  ('insurance_product_exam_points', 'save_product', false, 'write', JSON_ARRAY('insurance.product.write'), 'conditional', 'strong', true, 'managed-migration', 'managed-migration');
--> statement-breakpoint

INSERT IGNORE INTO `role_asset_grants` (`role_key`, `asset_type`, `asset_id`, `grant_mode`, `source`, `enabled`, `created_by`, `updated_by`) VALUES
  ('insurance-advisor', 'mcp_server', 'insurance_customer_profile', 'optional', 'seed', true, 'managed-migration', 'managed-migration'),
  ('insurance-advisor', 'mcp_server', 'insurance_product_exam_points', 'optional', 'seed', true, 'managed-migration', 'managed-migration');
