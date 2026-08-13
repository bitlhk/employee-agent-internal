ALTER TABLE `agent_tasks`
  ADD COLUMN `capability_intents_json` text NULL AFTER `artifacts_json`;
