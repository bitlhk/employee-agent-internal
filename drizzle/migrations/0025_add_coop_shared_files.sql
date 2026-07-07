CREATE TABLE IF NOT EXISTS `lx_coop_files` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `session_id` varchar(64) NOT NULL,
  `request_id` bigint NULL,
  `owner_user_id` int NOT NULL,
  `source_adopt_id` varchar(64) NULL,
  `source_path` varchar(1000) NULL,
  `stored_path` varchar(1200) NOT NULL,
  `name` varchar(300) NOT NULL,
  `size` bigint NOT NULL DEFAULT 0,
  `mime` varchar(160) NULL,
  `source_type` enum('upload','agent_workspace','final_artifact') NOT NULL DEFAULT 'upload',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_lx_coop_files_session` (`session_id`),
  KEY `idx_lx_coop_files_request` (`request_id`),
  KEY `idx_lx_coop_files_owner` (`owner_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
