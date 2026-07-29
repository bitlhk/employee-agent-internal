
-- Portable audit trigger attestation objects. The managed MySQL SHOW CREATE VIEW
-- output can qualify INFORMATION_SCHEMA columns with a case-sensitive table name,
-- so the backup deliberately recreates these objects with an explicit alias.
DROP VIEW IF EXISTS `audit_worm_trigger_status`;
CREATE SQL SECURITY DEFINER VIEW `audit_worm_trigger_status` AS
SELECT `trigger_metadata`.`TRIGGER_NAME` AS `name`
FROM `INFORMATION_SCHEMA`.`TRIGGERS` AS `trigger_metadata`
WHERE `trigger_metadata`.`TRIGGER_SCHEMA` = DATABASE()
  AND `trigger_metadata`.`TRIGGER_NAME` IN (
    'audit_events_no_update',
    'audit_events_no_delete',
    'audit_tool_events_no_update',
    'audit_tool_events_no_delete',
    'audit_exports_no_update',
    'audit_exports_no_delete',
    'audit_security_findings_no_delete',
    'audit_security_findings_restricted_update'
  );

DROP FUNCTION IF EXISTS `audit_worm_trigger_names`;
DELIMITER ;;
CREATE FUNCTION `audit_worm_trigger_names`() RETURNS JSON
READS SQL DATA
SQL SECURITY DEFINER
RETURN (
  SELECT COALESCE(JSON_ARRAYAGG(`trigger_metadata`.`TRIGGER_NAME`), JSON_ARRAY())
  FROM `INFORMATION_SCHEMA`.`TRIGGERS` AS `trigger_metadata`
  WHERE `trigger_metadata`.`TRIGGER_SCHEMA` = DATABASE()
    AND `trigger_metadata`.`TRIGGER_NAME` IN (
      'audit_events_no_update',
      'audit_events_no_delete',
      'audit_tool_events_no_update',
      'audit_tool_events_no_delete',
      'audit_exports_no_update',
      'audit_exports_no_delete',
      'audit_security_findings_no_delete',
      'audit_security_findings_restricted_update'
    )
);;
DELIMITER ;
