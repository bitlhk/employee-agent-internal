const path = require("node:path");

const appRoot = path.resolve(__dirname, "../..");
require("dotenv").config({ path: path.join(appRoot, ".env"), quiet: true });

module.exports = {
  apps: [{
    name: process.env.PM2_ALERT_APP_NAME || process.env.EA_ALERT_PM2_NAME || "employee-agent-alerts",
    cwd: appRoot,
    script: "scripts/feishu-alert-dispatcher.mjs",
    interpreter: process.execPath,
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 10,
    max_memory_restart: process.env.PM2_ALERT_MAX_MEMORY_RESTART || "256M",
    error_file: path.join(appRoot, "logs", "pm2-alert-error.log"),
    out_file: path.join(appRoot, "logs", "pm2-alert-out.log"),
    merge_logs: true,
    kill_timeout: 10000,
    time: true,
    env: {
      NODE_ENV: "production",
    },
  }],
};
