CREATE TABLE IF NOT EXISTS `install_events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `install_id` varchar(64) NOT NULL,
  `event_type` enum('command_copied','downloaded','started','succeeded','failed') NOT NULL,
  `stage` varchar(64) DEFAULT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'bootstrap',
  `installer_version` varchar(32) DEFAULT NULL,
  `os_type` varchar(32) DEFAULT NULL,
  `arch` varchar(32) DEFAULT NULL,
  `mirror` varchar(16) DEFAULT NULL,
  `duration_ms` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_install_events_install_event` (`install_id`, `event_type`),
  KEY `idx_install_events_event_created` (`event_type`, `created_at`),
  KEY `idx_install_events_install_created` (`install_id`, `created_at`)
);
