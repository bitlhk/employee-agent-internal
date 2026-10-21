CREATE TABLE IF NOT EXISTS `calendar_bindings` (
  `user_id` int NOT NULL,
  `username` varchar(128) NOT NULL,
  `calendar_name` varchar(128) NOT NULL,
  `encrypted_password` text NOT NULL,
  `enabled` boolean NOT NULL DEFAULT false,
  `discoverable` boolean NOT NULL DEFAULT false,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uk_calendar_bindings_username` (`username`)
);
