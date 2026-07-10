ALTER TABLE `business_agents`
  ADD COLUMN `provider_type` varchar(64) NULL AFTER `ui_config`,
  ADD COLUMN `adapter_protocol` varchar(96) NULL AFTER `provider_type`,
  ADD COLUMN `capabilities_json` text NULL AFTER `adapter_protocol`,
  ADD COLUMN `endpoint_config_json` text NULL AFTER `capabilities_json`;

UPDATE `business_agents`
SET
  `provider_type` = CASE
    WHEN `id` = 'task-data-demo' THEN 'http-sse'
    WHEN `id` IN ('task-legacy', 'task-business-a', 'task-business-b', 'task-business-c', 'task-business-d') THEN 'legacy'
    WHEN `kind` = 'local' THEN 'openclaw-local'
    ELSE 'openai-compatible'
  END,
  `adapter_protocol` = CASE
    WHEN `id` = 'task-data-demo' THEN 'data-demo-agent-v1'
    WHEN `id` = 'task-legacy' THEN 'legacy-events'
    WHEN `id` = 'task-business-a' THEN 'business-a-legacy-v1'
    WHEN `id` = 'task-business-b' THEN 'business-b-legacy-v1'
    WHEN `id` = 'task-business-c' THEN 'business-c-legacy-v1'
    WHEN `id` = 'task-business-d' THEN 'business-d-legacy-v1'
    WHEN `kind` = 'local' THEN 'openclaw-chat'
    ELSE 'openai-chat-completions'
  END,
  `capabilities_json` = CASE
    WHEN `id` IN ('task-ppt', 'task-code', 'task-slides') THEN '["chat","files","artifacts","long_task"]'
    WHEN `id` IN ('task-legacy', 'task-business-a', 'task-business-b', 'task-business-c', 'task-business-d') THEN '["chat","tools","long_task"]'
    WHEN `id` = 'task-data-demo' THEN '["chat","tools","long_task"]'
    ELSE '["chat"]'
  END
WHERE `provider_type` IS NULL OR `adapter_protocol` IS NULL;
