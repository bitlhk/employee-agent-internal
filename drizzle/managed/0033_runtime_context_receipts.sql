CREATE TABLE `runtime_context_receipts` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `receipt_id` varchar(64) NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `adoption_id` varchar(64) DEFAULT NULL,
  `runtime_agent_id` varchar(128) DEFAULT NULL,
  `tool_name` varchar(128) NOT NULL,
  `result_fingerprint` varchar(64) NOT NULL,
  `receipt_fingerprint` varchar(64) NOT NULL,
  `trusted_metadata_json` json NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_runtime_context_receipts_receipt_id` (`receipt_id`),
  KEY `idx_runtime_context_receipts_session_result` (`session_id`, `result_fingerprint`, `created_at`),
  KEY `idx_runtime_context_receipts_adoption_session` (`adoption_id`, `session_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
