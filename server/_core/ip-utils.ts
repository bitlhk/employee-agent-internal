/**
 * IP地址获取和标准化工具
 * 统一所有IP获取逻辑，确保记录和查询时使用相同的IP
 */

/**
 * 标准化IP地址
 * - 将 IPv6 的 ::1 映射为 127.0.0.1
 * - 移除 IPv6 地址的方括号
 * - 处理 ::ffff:127.0.0.1 这种 IPv4-mapped IPv6 地址
 */
export function normalizeIp(ip: string): string {
  if (!ip) return "unknown";
  
  // 移除方括号（如果有）
  ip = ip.replace(/^\[|\]$/g, "");
  
  // IPv6 localhost 映射为 IPv4 localhost
  if (ip === "::1" || ip === "::ffff:127.0.0.1") {
    return "127.0.0.1";
  }
  
  // IPv4-mapped IPv6 地址（::ffff:192.168.1.1）提取 IPv4 部分
  const ipv4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4MappedMatch) {
    return ipv4MappedMatch[1];
  }
  
  return ip;
}

/**
 * 获取客户端IP地址
 * 不直接信任可伪造的代理头；生产部署如在反向代理后，需要显式配置 TRUST_PROXY。
 * 
 * 优先级顺序：
 * 1. req.ip（由 Express trust proxy 统一计算）
 * 2. socket.remoteAddress（直接连接）
 * 3. 显式启用 TRUST_PROXY 时，才读取 x-forwarded-for / x-real-ip 等代理头
 * 
 * @param req Express Request 对象或包含 headers 和 socket 的对象
 * @returns 标准化后的客户端IP地址
 */
export function getClientIp(req: any): string {
  if (req.ip) {
    return normalizeIp(req.ip);
  }

  const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (remoteAddress) {
    return normalizeIp(remoteAddress);
  }

  if (!process.env.TRUST_PROXY) {
    console.warn("[IP Utils] Could not determine client IP, using 'unknown'");
    return "unknown";
  }

  // 显式信任代理时，才从 x-forwarded-for 获取（代理服务器场景）
  // x-forwarded-for 格式：client, proxy1, proxy2
  const xForwardedFor = req.headers?.["x-forwarded-for"] as string;
  if (xForwardedFor) {
    const ips = xForwardedFor.split(",").map(ip => ip.trim());
    // 返回第一个IP（客户端真实IP）
    if (ips[0]) {
      return normalizeIp(ips[0]);
    }
  }
  
  // 2. 从 x-real-ip 获取（nginx 等代理）
  const xRealIp = req.headers?.["x-real-ip"] as string;
  if (xRealIp) {
    return normalizeIp(xRealIp);
  }
  
  // 3. 从 x-client-ip 获取（某些代理）
  const xClientIp = req.headers?.["x-client-ip"] as string;
  if (xClientIp) {
    return normalizeIp(xClientIp);
  }
  
  // 4. 从 cf-connecting-ip 获取（Cloudflare）
  const cfConnectingIp = req.headers?.["cf-connecting-ip"] as string;
  if (cfConnectingIp) {
    return normalizeIp(cfConnectingIp);
  }
  
  console.warn("[IP Utils] Could not determine client IP, using 'unknown'");
  return "unknown";
}
