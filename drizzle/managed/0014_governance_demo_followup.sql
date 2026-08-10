ALTER TABLE `governance_demo_business_records`
  MODIFY COLUMN `status` enum('demo_draft','demo_updated','demo_followup') NOT NULL;
