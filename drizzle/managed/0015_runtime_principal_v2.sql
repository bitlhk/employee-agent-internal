CREATE TABLE IF NOT EXISTS `runtime_organizations` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `tenant_id` varchar(64) NOT NULL,
  `display_name` varchar(200) NOT NULL,
  `identity_source` varchar(64) NOT NULL DEFAULT 'legacy',
  `external_subject` varchar(191),
  `status` enum('active','disabled') NOT NULL DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `runtime_organizations_id` PRIMARY KEY (`id`),
  CONSTRAINT `uk_runtime_organizations_public_id` UNIQUE (`organization_id`),
  CONSTRAINT `uk_runtime_organizations_tenant_id` UNIQUE (`tenant_id`),
  CONSTRAINT `uk_runtime_organizations_external_subject` UNIQUE (`identity_source`,`external_subject`),
  KEY `idx_runtime_organizations_status` (`status`)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `runtime_organization_memberships` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `membership_id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `user_id` int NOT NULL,
  `group_ids` json NOT NULL,
  `membership_version` int NOT NULL DEFAULT 1,
  `status` enum('active','revoked') NOT NULL DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `revoked_at` timestamp NULL,
  CONSTRAINT `runtime_organization_memberships_id` PRIMARY KEY (`id`),
  CONSTRAINT `uk_runtime_org_memberships_public_id` UNIQUE (`membership_id`),
  CONSTRAINT `uk_runtime_org_memberships_org_user` UNIQUE (`organization_id`,`user_id`),
  KEY `idx_runtime_org_memberships_user_status` (`user_id`,`status`)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `runtime_authorization_snapshots` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `snapshot_id` varchar(64) NOT NULL,
  `authorization_fingerprint` varchar(64) NOT NULL,
  `tenant_id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `user_id` int NOT NULL,
  `adoption_id` varchar(64) NOT NULL,
  `agent_id` varchar(128) NOT NULL,
  `role_template` varchar(64) NOT NULL,
  `workspace_id` varchar(255) NOT NULL,
  `permission_profile` varchar(64) NOT NULL,
  `authority_json` json NOT NULL,
  `status` enum('active','revoked') NOT NULL DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` timestamp NULL,
  CONSTRAINT `runtime_authorization_snapshots_id` PRIMARY KEY (`id`),
  CONSTRAINT `uk_runtime_authz_snapshots_public_id` UNIQUE (`snapshot_id`),
  CONSTRAINT `uk_runtime_authz_snapshots_fingerprint` UNIQUE (`authorization_fingerprint`),
  KEY `idx_runtime_authz_snapshots_actor_created` (`user_id`,`created_at`),
  KEY `idx_runtime_authz_snapshots_org_created` (`organization_id`,`created_at`),
  KEY `idx_runtime_authz_snapshots_status_created` (`status`,`created_at`)
);
--> statement-breakpoint

INSERT IGNORE INTO `runtime_organizations`
  (`organization_id`, `tenant_id`, `display_name`, `identity_source`, `external_subject`)
SELECT
  CONCAT('org_', SUBSTRING(SHA2(`normalized_name`, 256), 1, 24)),
  CONCAT('tn_', SUBSTRING(SHA2(`normalized_name`, 256), 1, 24)),
  `display_name`,
  'legacy',
  `normalized_name`
FROM (
  SELECT LOWER(TRIM(`organization`)) AS `normalized_name`, MIN(TRIM(`organization`)) AS `display_name`
  FROM `users`
  WHERE `organization` IS NOT NULL AND TRIM(`organization`) <> ''
  GROUP BY LOWER(TRIM(`organization`))
) AS `legacy_organizations`;
--> statement-breakpoint

INSERT IGNORE INTO `runtime_organization_memberships`
  (`membership_id`, `organization_id`, `user_id`, `group_ids`)
SELECT
  CONCAT('mem_', SUBSTRING(SHA2(CONCAT('legacy:', `id`, ':', LOWER(TRIM(`organization`))), 256), 1, 24)),
  CONCAT('org_', SUBSTRING(SHA2(LOWER(TRIM(`organization`)), 256), 1, 24)),
  `id`,
  IF(`groupId` > 0, JSON_ARRAY(CAST(`groupId` AS CHAR)), JSON_ARRAY())
FROM `users`
WHERE `organization` IS NOT NULL AND TRIM(`organization`) <> '';
