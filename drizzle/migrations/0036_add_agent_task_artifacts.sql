ALTER TABLE `agent_tasks`
  ADD COLUMN `artifacts_json` text NULL AFTER `raw_events_json`;
