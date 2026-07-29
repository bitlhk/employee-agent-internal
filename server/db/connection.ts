import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import {
  configureDbPoolMetrics,
  observeDbPoolEvent,
  resetDbPoolMetrics,
} from "../_core/observability/metrics";

let _db: ReturnType<typeof drizzle> | null = null;
let _connection: mysql.Pool | null = null;
let _healthCheckTimer: NodeJS.Timeout | null = null;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function resolveDbPoolConfig(env: NodeJS.ProcessEnv = process.env): {
  connectionLimit: number;
  maxIdle: number;
  queueLimit: number;
  connectTimeout: number;
} {
  const connectionLimit = boundedInteger(env.DB_CONNECTION_LIMIT, 10, 2, 100);
  return {
    connectionLimit,
    maxIdle: Math.min(connectionLimit, boundedInteger(env.DB_MAX_IDLE, 2, 0, 100)),
    queueLimit: boundedInteger(env.DB_QUEUE_LIMIT, 100, 1, 10_000),
    connectTimeout: boundedInteger(env.DB_CONNECT_TIMEOUT_MS, 10_000, 1_000, 60_000),
  };
}

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.warn("[Database] DATABASE_URL is not set. Database operations will fail.");
    return null;
  }

  if (!_db) {
    try {
      const poolConfig = resolveDbPoolConfig();
      configureDbPoolMetrics(poolConfig);
      // 创建连接池
      const connection = mysql.createPool({
        uri: databaseUrl,
        // Drizzle maps MySQL TIMESTAMP strings as UTC. Keep the server session
        // in UTC as well so browser-local formatting does not add the DB host
        // timezone a second time.
        timezone: "Z",
        waitForConnections: true,
        connectionLimit: poolConfig.connectionLimit,
        maxIdle: poolConfig.maxIdle,
        idleTimeout: 45_000,
        queueLimit: poolConfig.queueLimit,
        // 连接超时设置
        connectTimeout: poolConfig.connectTimeout,
        // 启用 TCP keepalive 以保持连接活跃
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000,
      });

      connection.on('connection', (conn) => {
        observeDbPoolEvent("connection");
        conn.on('error', (err) => {
          console.error('[Database] Connection error:', err);
          observeDbPoolEvent("error");
          if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
            console.warn('[Database] Connection lost, will reconnect on next query');
          }
        });
        conn.query("SET time_zone = '+00:00'", (err: NodeJS.ErrnoException | null) => {
          if (err) {
            console.error('[Database] Failed to initialize UTC session timezone:', err.message);
          }
        });
      });

      connection.on('acquire', () => observeDbPoolEvent("acquire"));
      connection.on('release', () => observeDbPoolEvent("release"));
      connection.on('enqueue', () => observeDbPoolEvent("enqueue"));

      // 监听连接池错误
      (connection as any).on('error', (err: any) => {
        observeDbPoolEvent("error");
        console.error('[Database] Pool error:', err);
      });

      _connection = connection;
      _db = drizzle(connection) as any;

      // 测试连接
      await connection.query("SELECT 1");
      console.log("[Database] Connected successfully");

      // 定期检查连接健康。连接池空闲连接会在 idleTimeout 后主动释放；
      // 这里主要用于尽早发现数据库不可达，不依赖它保持所有池连接存活。
      _healthCheckTimer = setInterval(async () => {
        try {
          await connection.query("SELECT 1");
        } catch (error) {
          console.error("[Database] Health check failed:", error);
        }
      }, 60 * 1000);
      _healthCheckTimer.unref();
    } catch (error) {
      console.error("[Database] Failed to connect:", error);
      if (_healthCheckTimer) clearInterval(_healthCheckTimer);
      _healthCheckTimer = null;
      const failedConnection = _connection;
      _db = null;
      _connection = null;
      await failedConnection?.end().catch(() => undefined);
      // 不抛出错误，让调用者处理
    }
  }

  return _db;
}

export async function closeDbConnection(): Promise<void> {
  if (_healthCheckTimer) clearInterval(_healthCheckTimer);
  _healthCheckTimer = null;
  const connection = _connection;
  _db = null;
  _connection = null;
  resetDbPoolMetrics();
  await connection?.end();
}
