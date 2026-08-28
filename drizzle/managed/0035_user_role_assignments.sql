CREATE TABLE IF NOT EXISTS `user_role_assignments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `assignment_id` varchar(64) NOT NULL,
  `user_id` int NOT NULL,
  `role_template` varchar(64) NOT NULL,
  `status` enum('active','revoked') NOT NULL DEFAULT 'active',
  `is_default` boolean NOT NULL DEFAULT false,
  `assigned_by` int NULL,
  `assigned_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_role_assignments_public_id` (`assignment_id`),
  UNIQUE KEY `uk_user_role_assignments_user_role` (`user_id`, `role_template`),
  KEY `idx_user_role_assignments_user_status` (`user_id`, `status`),
  KEY `idx_user_role_assignments_user_default` (`user_id`, `is_default`, `status`)
);
--> statement-breakpoint
INSERT INTO `user_role_assignments` (
  `assignment_id`,
  `user_id`,
  `role_template`,
  `status`,
  `is_default`,
  `assigned_by`,
  `assigned_at`
)
SELECT
  CONCAT('ura_', SUBSTRING(SHA2(CONCAT(active_adoption.`userId`, ':', active_adoption.`roleTemplate`), 256), 1, 24)),
  active_adoption.`userId`,
  active_adoption.`roleTemplate`,
  'active',
  CASE WHEN active_adoption.`id` = (
    SELECT MAX(latest_adoption.`id`)
    FROM `claw_adoptions` latest_adoption
    WHERE latest_adoption.`userId` = active_adoption.`userId`
      AND latest_adoption.`status` IN ('creating', 'active', 'expiring')
  ) THEN true ELSE false END,
  NULL,
  active_adoption.`createdAt`
FROM `claw_adoptions` active_adoption
INNER JOIN (
  SELECT `userId`, `roleTemplate`, MAX(`id`) AS `latest_role_adoption_id`
  FROM `claw_adoptions`
  WHERE `status` IN ('creating', 'active', 'expiring')
  GROUP BY `userId`, `roleTemplate`
) latest_role
  ON latest_role.`latest_role_adoption_id` = active_adoption.`id`
ON DUPLICATE KEY UPDATE
  `status` = 'active',
  `revoked_at` = NULL;
