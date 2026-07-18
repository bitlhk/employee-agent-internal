CREATE TABLE IF NOT EXISTS `admin_mfa_credentials` (
  `user_id` INT NOT NULL,
  `secret_encrypted` VARCHAR(1024) NOT NULL,
  `recovery_code_digests` TEXT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `last_used_step` BIGINT NULL,
  `enabled_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`)
);
