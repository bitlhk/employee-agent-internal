-- 岗位智能体个性化设置：灵魂 / 记忆 / 上下文

CREATE TABLE IF NOT EXISTS `claw_profile_settings` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `adoptionId` BIGINT NOT NULL,
  `displayName` VARCHAR(100) NULL,
  `personaPrompt` TEXT NULL,
  `stylePreset` ENUM('steady_research','aggressive_trading','education_advisor','custom') NOT NULL DEFAULT 'steady_research',
  `memoryEnabled` ENUM('yes','no') NOT NULL DEFAULT 'yes',
  `memorySummary` TEXT NULL,
  `contextTurns` INT NOT NULL DEFAULT 20,
  `crossSessionContext` ENUM('yes','no') NOT NULL DEFAULT 'yes',
  `updatedBy` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_claw_profile_settings_adoptionId` (`adoptionId`),
  CONSTRAINT `fk_claw_profile_settings_adoptionId` FOREIGN KEY (`adoptionId`) REFERENCES `claw_adoptions`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
