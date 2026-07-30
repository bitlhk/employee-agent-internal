DELETE duplicate_task
FROM agent_tasks AS duplicate_task
INNER JOIN agent_tasks AS keeper
  ON duplicate_task.adopt_id = keeper.adopt_id
 AND duplicate_task.agent_id = keeper.agent_id
 AND duplicate_task.source_message_id = keeper.source_message_id
 AND duplicate_task.source_message_id IS NOT NULL
 AND (
   duplicate_task.created_at > keeper.created_at
   OR (
     duplicate_task.created_at = keeper.created_at
     AND duplicate_task.id > keeper.id
   )
 );
--> statement-breakpoint
SET @ea_agent_task_index_exists = (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'agent_tasks'
    AND index_name = 'uk_agent_tasks_source_message'
);
--> statement-breakpoint
SET @ea_agent_task_index_ddl = IF(
  @ea_agent_task_index_exists = 0,
  'ALTER TABLE `agent_tasks` ADD UNIQUE INDEX `uk_agent_tasks_source_message` (`adopt_id`, `agent_id`, `source_message_id`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE ea_agent_task_index_statement FROM @ea_agent_task_index_ddl;
--> statement-breakpoint
EXECUTE ea_agent_task_index_statement;
--> statement-breakpoint
DEALLOCATE PREPARE ea_agent_task_index_statement;
