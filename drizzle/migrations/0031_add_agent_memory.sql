ALTER TABLE `claw_profile_settings`
  ADD COLUMN `memory_mode` ENUM('learn_and_use','use_only','off') NOT NULL DEFAULT 'learn_and_use' AFTER `memoryEnabled`;

CREATE TABLE IF NOT EXISTS `agent_memory_items` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `adopt_id` VARCHAR(64) NOT NULL,
  `role_template` VARCHAR(64) NOT NULL,
  `scope` ENUM('role','user') NOT NULL DEFAULT 'role',
  `kind` ENUM('preference','instruction','entity','procedure') NOT NULL DEFAULT 'preference',
  `status` ENUM('candidate','active','superseded','forgotten','rejected','expired') NOT NULL DEFAULT 'candidate',
  `canonical_key` VARCHAR(191) NOT NULL,
  `content` TEXT NOT NULL,
  `source` ENUM('explicit','automatic','feedback','legacy') NOT NULL DEFAULT 'automatic',
  `confidence` INT NOT NULL DEFAULT 50,
  `evidence_count` INT NOT NULL DEFAULT 0,
  `version` INT NOT NULL DEFAULT 1,
  `last_observed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` TIMESTAMP NULL,
  `expires_at` TIMESTAMP NULL,
  `superseded_by_id` BIGINT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_agent_memory_scope_key` (`user_id`, `adopt_id`, `canonical_key`),
  KEY `idx_agent_memory_adopt_status` (`adopt_id`, `status`, `updated_at`),
  KEY `idx_agent_memory_user_status` (`user_id`, `status`, `updated_at`),
  KEY `idx_agent_memory_role_kind` (`role_template`, `kind`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `agent_memory_evidence` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `memory_id` BIGINT NOT NULL,
  `user_id` INT NOT NULL,
  `adopt_id` VARCHAR(64) NOT NULL,
  `source_type` ENUM('explicit','conversation','feedback','legacy') NOT NULL,
  `channel` VARCHAR(32) NOT NULL,
  `session_id` VARCHAR(160) NULL,
  `request_id` VARCHAR(160) NULL,
  `conversation_id` VARCHAR(128) NULL,
  `message_id` VARCHAR(128) NULL,
  `source_hash` VARCHAR(64) NOT NULL,
  `snippet` VARCHAR(1000) NULL,
  `metadata_json` JSON NULL,
  `observed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_agent_memory_evidence` (`memory_id`, `source_hash`),
  KEY `idx_agent_memory_evidence_item` (`memory_id`, `observed_at`),
  KEY `idx_agent_memory_evidence_conversation` (`adopt_id`, `conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `agent_memory_jobs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `idempotency_key` VARCHAR(191) NOT NULL,
  `user_id` INT NOT NULL,
  `adopt_id` VARCHAR(64) NOT NULL,
  `role_template` VARCHAR(64) NOT NULL,
  `channel` VARCHAR(32) NOT NULL,
  `session_id` VARCHAR(160) NULL,
  `request_id` VARCHAR(160) NULL,
  `conversation_id` VARCHAR(128) NULL,
  `status` ENUM('pending','running','done','failed','skipped') NOT NULL DEFAULT 'pending',
  `payload_encrypted` TEXT NULL,
  `attempts` INT NOT NULL DEFAULT 0,
  `next_attempt_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `error_message` VARCHAR(1000) NULL,
  `started_at` TIMESTAMP NULL,
  `completed_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_agent_memory_job_idempotency` (`idempotency_key`),
  KEY `idx_agent_memory_job_status` (`status`, `next_attempt_at`, `created_at`),
  KEY `idx_agent_memory_job_adopt` (`adopt_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `agent_memory_cursors` (
  `source_key` VARCHAR(191) NOT NULL,
  `channel` VARCHAR(32) NOT NULL,
  `last_timestamp_ms` BIGINT NOT NULL DEFAULT 0,
  `last_fingerprint` VARCHAR(64) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`source_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
