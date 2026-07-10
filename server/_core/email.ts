/**
 * 邮件发送服务
 * 支持通过SMTP发送邮件，开发环境可以输出到控制台
 * 优先从数据库读取配置，如果没有则从环境变量读取
 */

import { getSmtpConfig, getSystemConfigValue } from "../db";
import { randomInt } from "crypto";

/**
 * 生成6位数字验证码
 */
export function generateVerificationCode(): string {
  return randomInt(100000, 1000000).toString();
}

/**
 * 通用邮件发送函数
 */
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html: string
): Promise<boolean> {
  // 优先从数据库读取SMTP配置
  const dbConfig = await getSmtpConfig();
  let smtpHost: string | null = null;
  let smtpPort: string | null = null;
  let smtpUser: string | null = null;
  let smtpPassword: string | null = null;
  let smtpFrom: string | null = null;
  let smtpEnabled = false;

  if (dbConfig && dbConfig.enabled === "yes") {
    smtpHost = dbConfig.host;
    smtpPort = dbConfig.port;
    smtpUser = dbConfig.user;
    smtpPassword = dbConfig.password;
    smtpFrom = dbConfig.from || dbConfig.user;
    smtpEnabled = true;
  } else {
    // 降级到环境变量
    smtpHost = process.env.SMTP_HOST || null;
    smtpPort = process.env.SMTP_PORT || null;
    smtpUser = process.env.SMTP_USER || null;
    smtpPassword = process.env.SMTP_PASSWORD || null;
    smtpFrom = process.env.SMTP_FROM || smtpUser;
    smtpEnabled = !!(smtpHost && smtpPort && smtpUser && smtpPassword);
  }

  if (smtpEnabled && smtpHost && smtpPort && smtpUser && smtpPassword) {
    try {
      const nodemailer = await import("nodemailer").catch(() => null);
      if (nodemailer) {
        const port = parseInt(smtpPort);
        const isSecure = port === 465;
        const isQQMail = smtpHost.includes("qq.com") || smtpUser.includes("@qq.com");
        
        // QQ邮箱特殊配置
        const transporterConfig: any = {
          host: smtpHost,
          port: port,
          secure: isSecure, // true for 465 (SSL), false for 587 (TLS)
          auth: {
            user: smtpUser,
            pass: smtpPassword,
          },
        };

        // 对于587端口（TLS），默认校验证书；仅在明确配置时才允许自签名证书。
        if (!isSecure && port === 587) {
          transporterConfig.requireTLS = true;
          const allowSelfSigned =
            process.env.SMTP_ALLOW_SELF_SIGNED === "true" ||
            process.env.SMTP_TLS_REJECT_UNAUTHORIZED === "false";
          transporterConfig.tls = {
            rejectUnauthorized: !allowSelfSigned,
          };
        }

        // QQ邮箱特殊处理：from必须与user一致，且需要格式化
        let fromAddress: string;
        if (isQQMail) {
          // QQ邮箱要求from必须与user一致，但可以添加显示名称
          fromAddress = `"岗位智能体" <${smtpUser}>`;
        } else {
          fromAddress = smtpFrom || smtpUser;
        }

        const transporter = nodemailer.createTransport(transporterConfig);

        // 验证连接
        await transporter.verify();

        await transporter.sendMail({
          from: fromAddress,
          to,
          subject,
          text,
          html,
        });

        console.log(`[Email] Email sent to ${to} from ${fromAddress}`);
        return true;
      }
    } catch (error: any) {
      console.error("[Email] Failed to send email via SMTP:", error);
      // 提供更详细的错误信息
      if (error.code) {
        console.error(`[Email] Error code: ${error.code}`);
      }
      if (error.response) {
        console.error(`[Email] SMTP response: ${error.response}`);
      }
      throw error; // 重新抛出错误，让调用者处理
    }
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("SMTP is not configured");
  }

  // 开发环境：输出到控制台
  console.log("\n" + "=".repeat(60));
  console.log(`[Email] Email to ${to}`);
  console.log("=".repeat(60));
  console.log(`Subject: ${subject}`);
  console.log(`Text: ${text}`);
  if (html) {
    console.log(`HTML: ${html.substring(0, 100)}...`);
  }
  console.log("=".repeat(60) + "\n");

  return true;
}

/**
 * 发送验证码邮件
 */
export async function sendVerificationCodeEmail(
  email: string,
  code: string
): Promise<boolean> {
  const subject = "【岗位智能体平台】邮箱验证码";
  const text = `您的验证码是：${code}，验证码有效期为10分钟，请勿泄露给他人。`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #CF0A2C;">岗位智能体平台 - 邮箱验证码</h2>
      <p>您好，</p>
      <p>您的验证码是：</p>
      <div style="background-color: #f5f5f5; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
        <h1 style="color: #CF0A2C; font-size: 32px; margin: 0; letter-spacing: 8px;">${code}</h1>
      </div>
      <p>验证码有效期为10分钟，请勿泄露给他人。</p>
      <p style="color: #666; font-size: 12px; margin-top: 30px;">
        此邮件由系统自动发送，请勿回复。
      </p>
    </div>
  `;

  return await sendEmail(email, subject, text, html);
}

/**
 * 发送密码重置邮件
 * @param email 用户邮箱
 * @param resetToken 重置token
 * @param requestOrigin 可选的请求来源（从请求头 Origin 或 Referer 获取）
 */
export async function sendPasswordResetEmail(
  email: string,
  resetToken: string,
  requestOrigin?: string
): Promise<boolean> {
  // 安全：密码重置链接只从服务端配置取，不信任请求头（防钓鱼）
  const configUrl = (await getSystemConfigValue("frontend_url", "")).trim();
  const frontendUrl = configUrl || (process.env.FRONTEND_URL || "").trim() || "http://localhost:5174";
  // requestOrigin 参数保留向后兼容但不再使用
  
  const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;
  const subject = "【岗位智能体平台】密码重置";
  const text = `您请求重置密码。请点击以下链接进行密码重置：${resetUrl}。此链接将在 60 分钟后失效。`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #CF0A2C;">岗位智能体平台 - 密码重置</h2>
      <p>您好，</p>
      <p>您请求重置密码，请点击下面的链接重置您的密码：</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetUrl}" style="display: inline-block; background-color: #CF0A2C; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          重置密码
        </a>
      </div>
      <p>或者复制以下链接到浏览器打开：</p>
      <p style="color: #666; font-size: 12px; word-break: break-all;">${resetUrl}</p>
      <p style="color: #999; font-size: 12px; margin-top: 30px;">
        此链接有效期为60分钟，请勿泄露给他人。如果您没有请求重置密码，请忽略此邮件。
      </p>
      <p style="color: #666; font-size: 12px; margin-top: 30px;">
        此邮件由系统自动发送，请勿回复。
      </p>
    </div>
  `;

  return await sendEmail(email, subject, text, html);
}
