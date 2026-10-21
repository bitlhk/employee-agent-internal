ALTER TABLE `claw_collab_settings`
  ADD COLUMN `schedulingAcceptTask` enum('off','approval','auto') NULL,
  ADD COLUMN `schedulingSharingPolicy` enum('result-only','none') NULL,
  ADD COLUMN `schedulingDiscoverable` boolean NULL;
