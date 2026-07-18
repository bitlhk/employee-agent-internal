# Employee Agent 代码变更 Review 报告

本报告对近期合并到 `employee-agent` 项目中的代码变更进行了全面的审查（Review），重点关注**安全性**、**用户体验与功能拓展**以及**代码质量与测试覆盖**。

---

## 1. 安全性设计 (Security Design)

本次变更在防御沙箱逃逸与敏感信息泄露方面做了重要增强：

### 1.1 路径穿越与沙箱逃逸防御 (Path Traversal & Sandbox Escape)
在 [server/_core/file-path-security.ts](file:///home/ubuntu/employee-agent/server/_core/file-path-security.ts) 中引入了三个核心的安全解析函数：
*   **`lexicalWorkspacePath`**: 对输入路径段进行严格词法校验。排除了绝对路径、空字节（`\0`）以及包含 `..` 的路径段，最后通过 `path.resolve` 校验计算后的路径是否包含在 Workspace 根目录下（使用 `isWithin` 辅助函数）。
*   **`resolveExistingWorkspacePath`**: 进一步使用 `realpathSync` 彻底解析软链接（Symlink Bypass 防御），确保实际指向的物理路径亦处于合法的工作区（或允许的外部根目录）内。
*   **`resolveWorkspaceWritePath` & `resolveWorkspaceDeletePath`**: 确保写入和删除操作严格受限于工作区内，并针对软链接做了严格拦截。

> [!IMPORTANT]
> 这种多层防御（词法级排除、路径前缀校验、物理路径 `realpath` 校验）是防范容器和工作区沙箱逃逸的最佳实践，能够有效抵御利用符号链接（Symlinks）或特殊编码绕过校验的攻击。

### 1.2 敏感运行时路径脱敏 (Sensitive Paths Sanitization)
在 [shared/lib/public-runtime-path.ts](file:///home/ubuntu/employee-agent/shared/lib/public-runtime-path.ts) 中实现并测试了 `sanitizePublicRuntimePaths` 方法：
*   **机制**: 统一清洗输出中的底层私有运行时路径（如 `.jiuwenswarm` / `.openclaw` 等隐藏目录及其子路径），将其替换为通用的 `"workspace"` 或 `"[运行时目录]"`。
*   **应用范围**: 该方法已被深度织入到聊天历史提取（[claw-misc.ts](file:///home/ubuntu/employee-agent/server/_core/claw-misc.ts)）、WebSocket 转发处理（[jiuwenswarm-gateway-client.ts](file:///home/ubuntu/employee-agent/server/_core/jiuwenswarm-gateway-client.ts)）、权限响应与重试日志中，有效防止了服务器内部物理路径泄露给用户或第三方 API。

---

## 2. 功能与用户体验 (Features & UX)

### 2.1 附件（Artifacts）统一呈现
以前，助手生成的中间文件混杂在工具执行日志中，查找不便。本次重构极大地提升了文件产出的可见性与交互体验：
*   **后端持久化**: 在 [server/_core/jiuwen-session-artifacts.ts](file:///home/ubuntu/employee-agent/server/_core/jiuwen-session-artifacts.ts) 中新增了 `writeJiuwenSessionArtifacts`，将请求相关的产出文件统一记录到会话目录下的 `.ea-generated-files.json` 清单中。
*   **历史合并**: [claw-misc.ts](file:///home/ubuntu/employee-agent/server/_core/claw-misc.ts) 的 `extractJiuwenChatMessages` 能够自动从历史 `.jsonl` 工具调用日志以及 `.ea-generated-files.json` 清单中提取最新的产出文件，并以特殊的虚拟工具调用形式返回给前端。
*   **前端展现**: [client/src/components/ChatMessage.tsx](file:///home/ubuntu/employee-agent/client/src/components/ChatMessage.tsx) 在消息底部渲染专属的附件卡片列表，支持直观展示文件图标（针对图片、表格、代码、压缩包等）、大小及下载/预览操作。

### 2.2 强化版行内预览 (Inline Preview) 与沙箱防护
*   **预览支持**: 扩展了行内预览格式。除了传统的 HTML 之外，还支持了图片、PDF 等直接在浏览器或 iframe 中行内打开预览。
*   **XSS 防御**: 在 HTML 预览路由 [server/_core/claw-downloads.ts](file:///home/ubuntu/employee-agent/server/_core/claw-downloads.ts) 中使用了极为严格的 `Content-Security-Policy`（CSP）：
    ```
    default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'
    ```
    这彻底禁止了预览 HTML 时执行外部或行内 JavaScript、发起网络请求等，在提供富文本展示能力的同时，封堵了恶意 HTML 窃取用户 Cookie 或 Session 的通道。

---

## 3. 代码健壮性与测试覆盖 (Robustness & Tests)

本次变更编写了多项单元测试，确保逻辑正确且防范回归：
*   [server/_core/public-runtime-path.test.ts](file:///home/ubuntu/employee-agent/server/_core/public-runtime-path.test.ts) 测试了多种操作系统（Unix & Windows）下的敏感路径脱敏效果，包括模糊匹配与未完成的流式数据脱敏。
*   [server/_core/jiuwen-session-artifacts.test.ts](file:///home/ubuntu/employee-agent/server/_core/jiuwen-session-artifacts.test.ts) 测试了持久化清单的写入与读取。
*   [client/src/components/ChatMessage.test.ts](file:///home/ubuntu/employee-agent/client/src/components/ChatMessage.test.ts) 增加了前端附件卡片渲染及其格式化展示（如 `2.0 KB`）的用例。

目前项目共 **299 个单元测试全部通过**：
```bash
Test Files  56 passed (56)
Tests  299 passed (299)
```

---

## 4. 优化建议与持续改进 (Recommendations)

在审查过程中发现以下细节可进一步打磨：

### 4.1 细化 `claw-misc.ts` 中的路径安全过滤
在 [server/_core/claw-misc.ts](file:///home/ubuntu/employee-agent/server/_core/claw-misc.ts) 的 `generatedFilesFromToolCalls` 中，存在以下逻辑：
```typescript
const relative = path.relative(workspaceRoot, absolute).split(path.sep).join("/");
if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) continue;
```
*   **潜在风险**: 如果 `relative` 计算结果恰好是 `".."`, `startsWith("../")` 将会返回 `false`，导致它未被直接过滤掉（虽然随后的 `stats.isFile()` 会因为其是目录而拒绝，但这增加了解析非期望路径的隐患）。
*   **改进建议**: 建议将条件修改为更稳妥的 `relative.startsWith("..")`，或统一调用 [file-path-security.ts](file:///home/ubuntu/employee-agent/server/_core/file-path-security.ts) 中暴露的 `lexicalWorkspacePath` 校验函数以复用相同的安全边界定义。

### 4.2 清单持久化并发写入竞态
在 [server/_core/jiuwen-session-artifacts.ts](file:///home/ubuntu/employee-agent/server/_core/jiuwen-session-artifacts.ts) 中：
```typescript
const registry = readRegistry(registryPath);
registry.runs[requestId] = ...
writeFileSync(tempPath, ...);
renameSync(tempPath, registryPath);
```
*   **潜在问题**: 这是一个典型的 "Read-Modify-Write" 过程。如果在同一个会话内，多个请求或后台任务在极短时间内并行生成了文件并写入清单，可能存在交错读写导致部分记录被覆盖的风险。
*   **改进建议**: 若该场景可能在高并发下触发，建议引入轻量级的进程内文件互斥锁，或者在写入时通过队列排队写入。
