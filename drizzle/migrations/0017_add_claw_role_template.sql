ALTER TABLE `claw_adoptions`
  ADD COLUMN `roleTemplate` VARCHAR(64) NOT NULL DEFAULT 'general-assistant' AFTER `permissionProfile`,
  ADD COLUMN `industry` VARCHAR(32) NOT NULL DEFAULT 'general' AFTER `roleTemplate`,
  ADD COLUMN `runtime` VARCHAR(32) NOT NULL DEFAULT 'openclaw' AFTER `industry`;

UPDATE `claw_adoptions`
SET
  `roleTemplate` = COALESCE(NULLIF(`roleTemplate`, ''), 'general-assistant'),
  `industry` = COALESCE(NULLIF(`industry`, ''), 'general'),
  `runtime` = CASE
    WHEN `adoptId` LIKE 'lgj-%' THEN 'jiuwenswarm'
    WHEN `adoptId` LIKE 'lgh-%' THEN 'legacy'
    ELSE COALESCE(NULLIF(`runtime`, ''), 'openclaw')
  END;
