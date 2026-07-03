# 岗位智能体平台设计规范（Design Token System v1.0）

> 参考 Linear（暗色）+ Apple（浅色），面向企业定制化部署。

## 核心原则

1. **组件只用 `var(--oc-*)`**，不硬编码任何颜色/字号/间距
2. **品牌 × 主题正交**：accent 跟客户走，基础色跟明暗走
3. **企业客户只需配 3 个值**：accentColor + logo + fontFamily

## Token 速查

### 颜色

| Token | 暗色 | 浅色 | 用途 |
|-------|------|------|------|
| `--oc-bg` | #0a0c10 | #f5f5f7 | 页面底色 |
| `--oc-bg-elevated` | #0f1114 | #ffffff | 侧边栏、面板 |
| `--oc-bg-surface` | #181c24 | #ffffff | 卡片、弹窗 |
| `--oc-bg-hover` | rgba(255,255,255,0.04) | rgba(0,0,0,0.03) | hover 态 |
| `--oc-bg-active` | rgba(255,255,255,0.08) | rgba(0,0,0,0.06) | active/pressed |
| `--oc-text-primary` | #e5e7eb | #1d1d1f | 主文字 |
| `--oc-text-secondary` | #9ca3af | #6e6e73 | 描述、次要 |
| `--oc-text-tertiary` | #6b7280 | #86868b | placeholder |
| `--oc-text-quaternary` | #4b5563 | #aeaeb2 | 最淡文字 |
| `--oc-text-on-accent` | #ffffff | #ffffff | accent 背景上的文字 |
| `--oc-border` | rgba(255,255,255,0.08) | rgba(0,0,0,0.1) | 默认边框 |
| `--oc-border-subtle` | rgba(255,255,255,0.04) | rgba(0,0,0,0.05) | 最淡边框 |
| `--oc-border-strong` | rgba(255,255,255,0.14) | rgba(0,0,0,0.18) | 强调边框 |
| `--oc-accent` | 品牌色 | 品牌色 | 按钮、链接、高亮 |
| `--oc-accent-hover` | 品牌色变体 | 品牌色变体 | hover 态 |
| `--oc-accent-subtle` | 品牌色 10% | 品牌色 10% | 浅色背景 |

### 字号

| Token | 值 | 用途 |
|-------|-----|------|
| `--oc-text-2xs` | 10px | 最小标签 |
| `--oc-text-xs` | 11px | 时间戳 |
| `--oc-text-sm` | 12px | 按钮、caption |
| `--oc-text-base` | 13px | 卡片描述 |
| `--oc-text-md` | 14px | 正文、聊天 |
| `--oc-text-lg` | 16px | 导航、强调 |
| `--oc-text-xl` | 18px | 页面标题 |
| `--oc-text-2xl` | 21px | 大标题 |
| `--oc-text-3xl` | 28px | 展示标题 |

### 字重

| Token | 值 | 用途 |
|-------|-----|------|
| `--oc-weight-normal` | 400 | 正文阅读 |
| `--oc-weight-medium` | 500 | UI 强调、导航 |
| `--oc-weight-semibold` | 600 | 标题、按钮 |
| `--oc-weight-bold` | 700 | 大标题（少用）|

### 圆角

| Token | 值 | 用途 |
|-------|-----|------|
| `--oc-radius-xs` | 3px | inline code |
| `--oc-radius-sm` | 6px | 按钮、输入框 |
| `--oc-radius-md` | 8px | 卡片 |
| `--oc-radius-lg` | 12px | 面板 |
| `--oc-radius-xl` | 16px | 聊天气泡 |
| `--oc-radius-full` | 9999px | 胶囊标签 |

### 间距

`--oc-space-{1~12}` = 4px 到 48px，8px 网格。

### 动效

| Token | 值 | 用途 |
|-------|-----|------|
| `--oc-transition-fast` | 120ms | hover、active |
| `--oc-transition-normal` | 200ms | 面板展开 |
| `--oc-transition-slow` | 300ms | 页面切换 |

## 企业定制

### 最小配置（Admin 面板）

```json
{
  "accentColor": "#C7000B",
  "logo": "/images/workforce-agent.svg",
  "name": "岗位智能体平台"
}
```

设置后 `--oc-accent` 自动被覆盖，所有用 accent 的组件自动变色。

### 完整配置（高级）

BrandConfig 支持所有字段，见 `shared/brand.ts`。

## 迁移指南

把组件里的硬编码替换为 token：

```
❌ style={{ color: "#697086" }}
✅ style={{ color: "var(--oc-text-tertiary)" }}

❌ style={{ background: "rgba(255,255,255,0.04)" }}
✅ style={{ background: "var(--oc-bg-hover)" }}

❌ style={{ fontSize: 11 }}
✅ style={{ fontSize: "var(--oc-text-xs)" }}

❌ style={{ borderRadius: 8 }}
✅ style={{ borderRadius: "var(--oc-radius-md)" }}
```
