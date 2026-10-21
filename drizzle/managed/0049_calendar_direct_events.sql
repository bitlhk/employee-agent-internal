ALTER TABLE calendar_meetings MODIFY COLUMN coordination_id VARCHAR(64) NULL;
--> statement-breakpoint
ALTER TABLE calendar_meetings ADD COLUMN request_key VARCHAR(64) NULL;
--> statement-breakpoint
UPDATE calendar_meetings SET request_key = id WHERE request_key IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX uk_calendar_meeting_request ON calendar_meetings (creator_user_id, request_key);
