DELETE FROM `business_agents`
WHERE `id` IN (
  'task-legacy',
  'task-trace',
  'task-data-demo',
  'task-business-a',
  'task-business-b',
  'task-business-c',
  'task-business-d',
  'task-ppt',
  'task-code',
  'task-slides',
  'task-finance',
  'task-assistant',
  'task-legacy-example',
  'mcp-tavily-search',
  'a2a-sg-research'
);
