import type { CapacitorConfig } from "@capacitor/cli";

const serverUrl = process.env.LINGXIA_IOS_SERVER_URL || "https://example.com";

const config: CapacitorConfig = {
  appId: process.env.LINGXIA_IOS_APP_ID || "com.linggan.employeeagent",
  appName: process.env.LINGXIA_IOS_APP_NAME || "员工智能体",
  webDir: "www",
  server: {
    url: serverUrl,
    cleartext: false,
  },
};

export default config;
