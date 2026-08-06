CREATE TABLE `cron_job_creations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `adopt_id` varchar(64) NOT NULL,
  `idempotency_key` varchar(191) NOT NULL,
  `request_hash` varchar(64) NOT NULL,
  `status` enum('pending','succeeded','failed') NOT NULL DEFAULT 'pending',
  `job_id` varchar(128) NULL,
  `job_json` text NULL,
  `error_message` text NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cron_job_creations_adopt_key` (`adopt_id`, `idempotency_key`),
  KEY `idx_cron_job_creations_status_updated` (`status`, `updated_at`)
);
