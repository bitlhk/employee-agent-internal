ALTER TABLE `knowledge_documents`
  ADD COLUMN `source_asset_id` varchar(128) NULL AFTER `sha256`,
  ADD COLUMN `document_series_id` varchar(128) NULL AFTER `source_asset_id`,
  ADD COLUMN `supersedes_document_id` varchar(64) NULL AFTER `document_series_id`,
  ADD UNIQUE KEY `uk_knowledge_documents_base_source_asset` (`knowledge_base_id`, `source_asset_id`),
  ADD KEY `idx_knowledge_documents_base_series_lifecycle` (`knowledge_base_id`, `document_series_id`, `lifecycle`),
  ADD KEY `idx_knowledge_documents_supersedes` (`supersedes_document_id`);
--> statement-breakpoint

UPDATE `knowledge_documents`
SET `document_series_id` = `public_id`
WHERE `document_series_id` IS NULL;
