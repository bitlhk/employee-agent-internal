const path = require("node:path");

const appRoot = path.resolve(__dirname, "../..");
require("dotenv").config({ path: path.join(appRoot, ".env"), quiet: true });

module.exports = {
  apps: [{
    name: process.env.EA_ALERT_PM2_NAME || "employee-agent-alerts",
    cwd: appRoot,
    script: "scripts/feishu-alert-dispatcher.mjs",
    interpreter: process.execPath,
    autorestart: Boolean(process.env.EA_ALERT_FEISHU_WEBHOOK_URL),
    restart_delay: 5000,
    max_restarts: 10,
    time: true,
    env: {
      NODE_ENV: "production",
    },
  }],
};
