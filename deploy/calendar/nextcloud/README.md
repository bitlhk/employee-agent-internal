# 本地日程系统

需要 Docker Desktop 的 Linux 容器环境或 Linux 上的 Docker Compose。本机尚未部署时，平台会明确显示未连接。

1. 复制 `.env.example` 为本目录的 `.env`，填入官方 Nextcloud 镜像的明确 apache 版本及随机密码。
2. 在本目录执行 `docker compose up -d`。访问 http://127.0.0.1:8088。
3. 使用 `docker compose exec --user www-data app php occ app:install calendar` 安装日历应用。
4. 为每位平台用户创建独立的 Nextcloud 用户，使用该用户自己的应用密码。不能用管理员密码代替个人访问凭据。
5. 平台 `.env` 设置 `NEXTCLOUD_BASE_URL=http://127.0.0.1:8088`，重启平台后端。
6. 执行 `node --import tsx scripts/db-migrate.ts apply`，日程能力归入通用助手；使用本人账号连接日历（名称一般为 personal）。对话中的草稿由本人在消息内确认；日历页面提供增删改查和配置，不要求创建独立日程岗位。部署时应用运行服务补丁并重启，详见项目日程实施文档。
7. 用户登录平台后查看日程，管理员核对数据确属本人。在“忙闲回复设置”保存与本人日历一致的 IANA 时区（如 Asia/Shanghai）；全天写入需要此设置。

凭据加密存储在 calendar_bindings；设置稳定的 CREDENTIAL_ENCRYPTION_KEY（默认回退 JWT_SECRET），换密钥前必须迁移凭据。账号唯一绑定一个平台用户。

支持本人读写、组织内名称搜索、添加参与人、自然语言安排、候选推荐及对话中的多人忙闲协作。会议和日程均可直接创建，不强制查询忙闲或等待邀请回复。管理员维护组织成员及与 Nextcloud 用户一致的参与人邮箱，单独启用本人写入；用户自行控制自动忙闲回复。没有组织仍可管理个人日历，协作需要有效组织身份。提醒主动写入本人工作区对话，不设日历通知入口。未配置 SMTP，不提供邮件通知。CalDAV 服务必须返回展开的重复事件；无法完整解释的时间或事件导致明确失败，不视为有空。

后台每30秒恢复可自动执行的协调任务与已确认操作，未确认草稿不执行。模型连接复用平台模型配置；可设置 EA_ASSISTANT_MODEL_ENV_PATH 指向本机已有 .env，其 MODEL_BASE_URL、MODEL_NAME 和 MODEL_API_KEY 不会暴露给前端。日常在平台登录即可使用日程助手，直接登录 Nextcloud 网页仍使用该系统账号。

## 本机开发部署

本机已在 WSL2 Ubuntu 内运行 Docker，Nextcloud 入口为 http://127.0.0.1:8088。部署凭据在本目录忽略的 `.env` 中，个人账号初始凭据在 `C:/ProgramData/MySQL/EmployeeAgent/calendar-accounts.json`，不进入 Git。

新平台用户可在明确的本地开发环境中运行 `node --import tsx scripts/provision-local-calendar.ts --local` 创建本人账号、日历和绑定。该脚本只连接本机，保留已有绑定与账号密码；首次创建启用本人读写及人员名称可发现性，不授予其他人的日历访问权限。正式环境使用管理员审核绑定和个人应用密码。

Docker 命名卷保存数据库及日历文件。停止服务使用 `docker compose down`，不要加 `-v`，以免删除数据。生产部署必须配置 HTTPS、备份、镜像固定和独立凭据管理。
