ALTER TABLE `custom_mcp_call_receipts`
  ADD COLUMN `approval_id` varchar(64) NULL AFTER `policy_decision_id`,
  ADD KEY `idx_custom_mcp_call_approval` (`approval_id`);
--> statement-breakpoint

ALTER TABLE `enterprise_mcp_call_receipts`
  ADD COLUMN `approval_id` varchar(64) NULL AFTER `policy_decision_id`,
  ADD KEY `idx_enterprise_mcp_call_approval` (`approval_id`);
--> statement-breakpoint

CREATE TABLE `governance_demo_business_records` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `record_id` varchar(64) NOT NULL,
  `request_id` varchar(64) NOT NULL,
  `tenant_id` varchar(80) NOT NULL,
  `user_id` int NOT NULL,
  `adopt_id` varchar(64) NOT NULL,
  `agent_id` varchar(128) NOT NULL,
  `role_key` varchar(64) NOT NULL,
  `tool_name` varchar(256) NOT NULL,
  `idempotency_key` varchar(191) NOT NULL,
  `customer_ref` varchar(128) NOT NULL,
  `status` enum('demo_draft','demo_updated') NOT NULL,
  `payload_json` json NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_governance_demo_record_id` (`record_id`),
  UNIQUE KEY `uk_governance_demo_request_id` (`request_id`),
  UNIQUE KEY `uk_governance_demo_idempotency` (`tenant_id`, `tool_name`, `idempotency_key`),
  KEY `idx_governance_demo_actor_created` (`user_id`, `created_at`),
  KEY `idx_governance_demo_adoption_created` (`adopt_id`, `created_at`)
);
