CREATE OR REPLACE SQL SECURITY DEFINER VIEW `audit_worm_trigger_status` AS
SELECT `TRIGGER_NAME` AS `name`
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
  );
