ALTER TABLE `agent_tasks`
  ADD COLUMN `parent_task_id` varchar(64) NULL AFTER `id`,
  ADD COLUMN `interaction_json` text NULL AFTER `raw_events_json`,
  ADD COLUMN `interaction_status` varchar(16) NULL AFTER `interaction_json`,
  ADD COLUMN `interaction_response_json` text NULL AFTER `interaction_status`,
  ADD COLUMN `interaction_answered_at` timestamp NULL AFTER `interaction_response_json`,
  ADD INDEX `idx_agent_tasks_parent` (`parent_task_id`);
