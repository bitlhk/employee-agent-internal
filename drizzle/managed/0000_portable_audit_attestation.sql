DROP TRIGGER IF EXISTS `audit_events_no_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_events_no_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_tool_events_no_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_tool_events_no_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_exports_no_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_exports_no_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_security_findings_no_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `audit_security_findings_restricted_update`;
--> statement-breakpoint
CREATE TRIGGER `audit_events_no_update`
BEFORE UPDATE ON `audit_events`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_events is WORM, UPDATE not allowed';
--> statement-breakpoint
CREATE TRIGGER `audit_events_no_delete`
BEFORE DELETE ON `audit_events`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_events is WORM, DELETE not allowed';
--> statement-breakpoint
CREATE TRIGGER `audit_tool_events_no_update`
BEFORE UPDATE ON `audit_tool_events`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_tool_events is WORM, UPDATE not allowed';
--> statement-breakpoint
CREATE TRIGGER `audit_tool_events_no_delete`
BEFORE DELETE ON `audit_tool_events`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_tool_events is WORM, DELETE not allowed';
--> statement-breakpoint
CREATE TRIGGER `audit_exports_no_update`
BEFORE UPDATE ON `audit_exports`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_exports is WORM, UPDATE not allowed';
--> statement-breakpoint
CREATE TRIGGER `audit_exports_no_delete`
BEFORE DELETE ON `audit_exports`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_exports is WORM, DELETE not allowed';
--> statement-breakpoint
CREATE TRIGGER `audit_security_findings_no_delete`
BEFORE DELETE ON `audit_security_findings`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_security_findings is WORM, DELETE not allowed';
--> statement-breakpoint
CREATE TRIGGER `audit_security_findings_restricted_update`
BEFORE UPDATE ON `audit_security_findings`
FOR EACH ROW
BEGIN
  IF NOT (
    OLD.`id` <=> NEW.`id`
    AND OLD.`finding_id` <=> NEW.`finding_id`
    AND OLD.`event_id` <=> NEW.`event_id`
    AND OLD.`finding_type` <=> NEW.`finding_type`
    AND OLD.`severity` <=> NEW.`severity`
    AND OLD.`title` <=> NEW.`title`
    AND OLD.`description` <=> NEW.`description`
    AND OLD.`evidence_json` <=> NEW.`evidence_json`
    AND OLD.`target_type` <=> NEW.`target_type`
    AND OLD.`target_id` <=> NEW.`target_id`
    AND OLD.`created_at` <=> NEW.`created_at`
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_security_findings immutable fields cannot be updated';
  END IF;
END;
--> statement-breakpoint
CREATE OR REPLACE SQL SECURITY DEFINER VIEW `audit_worm_trigger_status` AS
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
