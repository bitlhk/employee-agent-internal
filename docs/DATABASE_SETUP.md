# 数据库配置说明

## 问题

如果遇到 `Database not available` 错误，说明数据库连接配置不正确。

## 解决方案

### 1. 配置数据库连接字符串

编辑项目根目录的 `.env` 文件，设置 `DATABASE_URL`：

```env
DATABASE_URL=mysql://用户名:密码@主机:端口/数据库名
```

**示例**：
```env
# 本地 MySQL
DATABASE_URL=mysql://root:password@localhost:3306/employee_agent

# 远程 MySQL
DATABASE_URL=mysql://user:pass@example.com:3306/employee_agent
```

### 2. 创建数据库

如果数据库不存在，需要先创建：

```sql
CREATE DATABASE employee_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 3. 运行数据库迁移

配置好 `DATABASE_URL` 后，运行迁移创建表结构：

```bash
pnpm db:deploy
```

`db:deploy` 会区分两种情况：

- 空数据库：先依据 `drizzle/schema.ts` 创建当前基线，再执行受管前向迁移。
- 已有数据库：必须通过 `config/schema-baseline-v1.json` 的表和字段校验，才登记基线并执行前向迁移，不会重放历史 SQL。

生产环境必须配置独立的 `DATABASE_MIGRATION_URL`，只在发布窗口提供 DDL 权限；应用运行时继续使用权限更小的 `DATABASE_URL`。迁移会先用随机临时对象验证建表、触发器和视图权限，探针失败时不会修改业务表。

日常命令：

```bash
pnpm db:migrate         # 应用待执行迁移
pnpm db:migrate:check   # 确认基线、校验和及待执行状态
pnpm db:migrate:status  # 查看状态
```

`pnpm db:push` 只用于尚未建立受管基线的本地开发数据库。生产发布不得使用 `drizzle-kit push`。

从早期版本升级时，如果基线检查只报告 `lx_coop_user_hidden.created_at` 缺失，可在备份后使用 DDL 账号显式执行 `pnpm db:baseline:repair`。该命令只修复这一条已知历史漂移；出现任何其他缺表或缺列都会失败关闭，禁止自动猜测结构。

### 4. 验证数据库连接

重启后端服务器后，查看日志应该显示：

```
[Database] Connected successfully
```

如果看到错误信息，检查：
- `DATABASE_URL` 格式是否正确
- 数据库服务是否运行
- 用户名和密码是否正确
- 数据库是否存在

## 数据库表结构

项目使用以下表：

1. **users** - 用户表（OAuth 认证）
2. **registrations** - 注册用户表
3. **visit_stats** - 访问统计表

表结构定义在 `drizzle/schema.ts`，受管前向迁移位于 `drizzle/managed/`。`drizzle/migrations/` 仅保留旧版本变更记录。

## 开发环境建议

对于本地开发，可以使用：

1. **Docker MySQL**：
```bash
docker run --name employee-agent-mysql -e MYSQL_ROOT_PASSWORD=password -e MYSQL_DATABASE=employee_agent -p 3306:3306 -d mysql:8.0
```

2. **本地 MySQL**：
确保 MySQL 服务运行，然后配置 `.env` 文件。

3. **云数据库**：
使用云服务商提供的 MySQL 实例，配置连接字符串即可。

## 故障排查

### 错误：Database not available

- 检查 `.env` 文件中是否有 `DATABASE_URL`
- 检查 `DATABASE_URL` 格式是否正确
- 检查数据库服务是否运行
- 查看后端服务器日志中的错误信息

### 错误：Access denied

- 检查用户名和密码是否正确
- 检查用户是否有访问数据库的权限

### 错误：Unknown database

- 确保数据库已创建
- 检查数据库名称是否正确
