DROP FUNCTION IF EXISTS `audit_worm_trigger_names`;

CREATE FUNCTION `audit_worm_trigger_names`() RETURNS JSON
READS SQL DATA
SQL SECURITY DEFINER
RETURN (
  SELECT COALESCE(JSON_ARRAYAGG(`TRIGGER_NAME`), JSON_ARRAY())
  FROM `INFORMATION_SCHEMA`.`TRIGGERS`
  WHERE `TRIGGER_SCHEMA` = DATABASE()
    AND `TRIGGER_NAME` IN (
      'audit_events_no_update',
      'audit_events_no_delete',
      'audit_tool_events_no_update',
      'audit_tool_events_no_delete',
      'audit_exports_no_update',
      'audit_exports_no_delete',
      'audit_security_findings_no_delete',
      'audit_security_findings_restricted_update'
    )
);

-- Grant only EXECUTE on this function to the runtime account during deployment.
