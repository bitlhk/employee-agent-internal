CREATE TABLE `calendar_provisioning` (
  `user_id` int NOT NULL PRIMARY KEY,
  `username` varchar(128) NOT NULL UNIQUE,
  `encrypted_password` text NOT NULL,
  `status` enum('creating','ready','failed') NOT NULL DEFAULT 'creating',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
