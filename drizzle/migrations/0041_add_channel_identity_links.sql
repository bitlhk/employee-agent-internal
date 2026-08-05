CREATE TABLE IF NOT EXISTS `channel_identity_links` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `provider` varchar(40) NOT NULL,
  `providerSubject` varchar(128) NOT NULL,
  `userId` int NOT NULL,
  `verifiedEmail` varchar(320) NULL,
  `verifiedPhone` varchar(24) NULL,
  `lastSeenAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `channel_identity_provider_subject_unique` (`provider`, `providerSubject`),
  KEY `channel_identity_user_idx` (`userId`)
);
