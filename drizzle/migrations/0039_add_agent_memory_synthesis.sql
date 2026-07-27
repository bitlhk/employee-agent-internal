CREATE TABLE IF NOT EXISTS `agent_memory_syntheses` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `adopt_id` VARCHAR(64) NOT NULL,
  `slot` ENUM('profile','recent','playbook') NOT NULL,
  `canonical_key` VARCHAR(191) NOT NULL,
  `content` TEXT NOT NULL,
  `memory_ids_json` JSON NOT NULL,
  `source_signature` VARCHAR(64) NOT NULL,
  `confidence` INT NOT NULL DEFAULT 70,
  `model` VARCHAR(160) NOT NULL DEFAULT '',
  `generated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_agent_memory_synthesis_key` (`user_id`, `adopt_id`, `canonical_key`),
  KEY `idx_agent_memory_synthesis_slot` (`adopt_id`, `slot`, `updated_at`),
  KEY `idx_agent_memory_synthesis_signature` (`adopt_id`, `source_signature`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `agent_memory_synthesis_state` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `adopt_id` VARCHAR(64) NOT NULL,
  `desired_signature` VARCHAR(64) NOT NULL DEFAULT '',
  `completed_signature` VARCHAR(64) NOT NULL DEFAULT '',
  `status` ENUM('pending','running','ready','failed') NOT NULL DEFAULT 'pending',
  `model` VARCHAR(160) NOT NULL DEFAULT '',
  `error_message` VARCHAR(1000) NULL,
  `started_at` TIMESTAMP NULL,
  `completed_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_agent_memory_synthesis_state` (`user_id`, `adopt_id`),
  KEY `idx_agent_memory_synthesis_state_status` (`status`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
