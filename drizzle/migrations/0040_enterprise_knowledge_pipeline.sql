ALTER TABLE `knowledge_bases`
  ADD COLUMN `classification` ENUM('public','internal','sensitive','restricted') NOT NULL DEFAULT 'internal' AFTER `description`,
  ADD COLUMN `external_processing_allowed` BOOLEAN NOT NULL DEFAULT TRUE AFTER `classification`,
  ADD COLUMN `index_version` VARCHAR(96) NULL AFTER `last_error`,
  ADD COLUMN `index_schema_version` INT NOT NULL DEFAULT 1 AFTER `index_version`;

ALTER TABLE `knowledge_documents`
  ADD COLUMN `version_label` VARCHAR(64) NOT NULL DEFAULT '1.0' AFTER `sha256`,
  ADD COLUMN `lifecycle` ENUM('draft','active','expired','archived') NOT NULL DEFAULT 'active' AFTER `version_label`,
  ADD COLUMN `source_department` VARCHAR(120) NOT NULL DEFAULT '' AFTER `lifecycle`,
  ADD COLUMN `classification` ENUM('public','internal','sensitive','restricted') NOT NULL DEFAULT 'internal' AFTER `source_department`,
  ADD COLUMN `authority` ENUM('official','approved','reference','personal') NOT NULL DEFAULT 'reference' AFTER `classification`,
  ADD COLUMN `external_processing_allowed` BOOLEAN NOT NULL DEFAULT TRUE AFTER `authority`,
  ADD COLUMN `effective_at` TIMESTAMP NULL AFTER `external_processing_allowed`,
  ADD COLUMN `expires_at` TIMESTAMP NULL AFTER `effective_at`,
  ADD COLUMN `parser_version` VARCHAR(32) NULL AFTER `last_error`,
  ADD COLUMN `index_version` VARCHAR(96) NULL AFTER `parser_version`,
  ADD KEY `idx_knowledge_documents_base_lifecycle` (`knowledge_base_id`, `lifecycle`, `updated_at`);

CREATE TABLE IF NOT EXISTS `knowledge_index_jobs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `knowledge_base_id` BIGINT NOT NULL,
  `reason` VARCHAR(64) NOT NULL DEFAULT 'content_changed',
  `status` ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
  `attempts` INT NOT NULL DEFAULT 0,
  `last_error` VARCHAR(1000) NULL,
  `locked_at` TIMESTAMP NULL,
  `finished_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_knowledge_index_jobs_status_created` (`status`, `created_at`),
  KEY `idx_knowledge_index_jobs_base_created` (`knowledge_base_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
