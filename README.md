# DNSHE 免费域名自动续期工具（多账户版 + 邮件通知 + 密码保护）

[![License](https://img.shields.io/github/license/haianyun/MultiDNSHERenew?style=flat-square)](LICENSE)
[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy%20To-Cloudflare%20Workers-orange?style=flat-square)](https://workers.cloudflare.com)

基于 [Townwang/DnsheAutoRenew](https://github.com/Townwang/DnsheAutoRenew) 改进，支持**多账户管理 + 定时自动续期 + 邮件报告通知 + 密码保护**。

## ✨ 功能特性
- ✅ **多账户支持** — 通过 `ACCOUNTS` JSON 数组管理多个 DNSHE 账户
- ✅ **密码保护** — 可选 `PASSWORD` 环境变量，保护 Web 页面和 API
- ✅ **邮件报告通知** — 每次续期后自动发送邮件报告（支持 Resend / SendGrid / Mailgun）
- ✅ **按账户续期** — Web 界面可选中单个账户或一键续期全部
- ✅ **诊断端点** — `/debug` 端点查看环境变量配置状态
- ✅ **向后兼容** — 仍支持旧版 `API_KEY + API_SECRET` 单账户模式
- ✅ **定时自动执行** — Cron 触发器，无需人工值守

---

## 目录
1. [快速部署](#1-快速部署)
2. [环境变量配置](#2-环境变量配置)
3. [邮件通知配置](#3-邮件通知配置)
4. [密码保护](#4-密码保护)
5. [使用说明](#5-使用说明)
6. [常见问题 FAQ](#6-常见问题-faq)

---

## 1. 快速部署

### 1.1 前提准备
- [Cloudflare 账号](https://dash.cloudflare.com)（免费注册）
- DNSHE 账号的 **API Key** 和 **API Secret**（[获取方法](https://my.dnshe.com/knowledgebase/5/)）
- （可选）邮件服务 API Key，用于接收续期报告

### 1.2 部署 Worker
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **创建应用程序 → 创建 Worker**
2. 自定义名称（如 `dnshe-renew`），点击**部署**
3. 进入编辑页面，删除默认代码，将 `src/worker.js` 全部内容粘贴进去
4. 点击**保存并部署**

### 1.3 配置环境变量
进入 Worker **设置 → 变量**，添加以下变量（勾选加密）：

### 1.4 配置定时触发
**设置 → 触发器 → 添加 Cron 触发器**，输入 `0 0 1 */6 *`（每 6 个月执行一次）

---

## 2. 环境变量配置

### 必填：ACCOUNTS（多账户）

```json
[
  {"key": "your_api_key_1", "secret": "your_api_secret_1", "name": "账户一"},
  {"key": "your_api_key_2", "secret": "your_api_secret_2", "name": "账户二"}
]
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `key` | 是 | DNSHE API Key |
| `secret` | 是 | DNSHE API Secret |
| `name` | 否 | 账户显示名称（不填则显示 Key 前 8 位） |

> **新增账户**：只需在 JSON 数组中追加一个对象，保存并重新部署即可生效。

### 向后兼容（单账户）

| 变量名 | 说明 |
|--------|------|
| `API_KEY` | DNSHE API Key（仅当未配置 ACCOUNTS 时生效） |
| `API_SECRET` | DNSHE API Secret（仅当未配置 ACCOUNTS 时生效） |

### 环境变量速查表

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `ACCOUNTS` | 是 | 多账户 JSON 数组 |
| `PASSWORD` | 否 | Web 页面访问密码（不设则公开访问） |
| `EMAIL_TO` | 否 | 接收报告的邮箱 |
| `EMAIL_API_KEY` | 否 | 邮件服务 API Key |
| `EMAIL_SERVICE` | 否 | 邮件服务: `resend`(默认) / `sendgrid` / `mailgun` |
| `EMAIL_FROM` | 否 | 自定义发件人地址 |
| `MAILGUN_DOMAIN` | 否 | Mailgun 域名（仅 Mailgun 需要） |

---

## 3. 邮件通知配置

续期完成后自动发送邮件报告，支持以下三种服务（任选其一）：

### 推荐：Resend（注册即用，100 封/天免费）

1. 访问 [resend.com](https://resend.com) 注册账号
2. 进入 **API Keys** 页面，创建 API Key（格式：`re_xxxxxx`）
3. **重要**：免费层只能向已验证的邮箱发送。在 **API Keys → Authorized Recipients** 中添加你的邮箱并完成验证
4. 在 Workers 环境变量中添加：

| 变量名 | 值 |
|--------|-----|
| `EMAIL_TO` | `your@email.com`（已验证的邮箱） |
| `EMAIL_API_KEY` | `re_xxxxxx`（Resend API Key） |
| `EMAIL_SERVICE` | `resend`（可省略，默认值） |

> 如需自定义发件人域名，在 Resend **Domains** 页面验证域名并添加 DNS 记录，然后设置 `EMAIL_FROM`。

### 备选：SendGrid（100 封/天免费）

| 变量名 | 值 |
|--------|-----|
| `EMAIL_TO` | `your@email.com` |
| `EMAIL_API_KEY` | `SG.xxxxxx`（SendGrid API Key） |
| `EMAIL_SERVICE` | `sendgrid` |

### 备选：Mailgun

| 变量名 | 值 |
|--------|-----|
| `EMAIL_TO` | `your@email.com` |
| `EMAIL_API_KEY` | Mailgun API Key |
| `EMAIL_SERVICE` | `mailgun` |
| `MAILGUN_DOMAIN` | 你的 Mailgun 域名 |

---

## 4. 密码保护

在 Workers **设置 → 变量** 中添加：

| 变量名 | 值 |
|--------|-----|
| `PASSWORD` | `你的密码` |

- **不设置**：页面和 API 公开访问
- **设置后**：访问任何页面都需要先登录
- 登录后 24 小时免密（基于 Cookie + SHA-256 签名认证）
- 定时任务不受密码影响

---

## 5. 使用说明

### 5.1 诊断配置
部署后访问 `https://你的Worker域名/debug` 查看所有环境变量状态和 JSON 解析结果。

### 5.2 Web 手动续期
1. 浏览器打开 Worker 域名
2. （如已设置密码）输入密码登录
3. 页面顶部显示账户列表和配置状态
4. **点击账户标签** → 仅续期该账户；**不选** → 续期全部
5. 点击**开始续期**，实时查看日志

### 5.3 定时自动续期
Cron 触发器按时自动执行，每次完成后自动发送邮件报告。

### 5.4 邮件报告示例

```
DNSHE 域名自动续期报告
========================================
执行时间: 2026-06-18 08:00 UTC
耗时: 12 秒
账户数量: 2

--- 账户一 ---
  活跃域名: 10 个
  跳过(无需续期): 10 个
  续期成功: 0 个
  续期失败: 0 个

--- 账户二 ---
  活跃域名: 9 个
  跳过(无需续期): 9 个
  续期成功: 0 个
  续期失败: 0 个

========================================
合计: 2 个账户, 19 个域名
续期成功: 0, 失败: 0, 跳过: 19
```

---

## 6. 常见问题 FAQ

### Q1：如何获取 DNSHE API Key？
登录 [DNSHE](https://www.dnshe.com) → 头像 → API 密钥管理 → 生成密钥。

### Q2：邮件没收到？
检查：① `EMAIL_TO` 和 `EMAIL_API_KEY` 是否正确；② API Key 是否有效；③ 查看 Cloudflare Workers 日志页面确认发送状态。

### Q3：如何添加新账户？
在 `ACCOUNTS` JSON 数组中追加新对象：`{"key":"新key","secret":"新secret","name":"新账户"}`，保存部署即可。

### Q4：Resend 免费额度够用吗？
免费额度 100 封/天，本工具每 6 个月发一封，绰绰有余。

### Q5：安全吗？
API 密钥和密码通过 Cloudflare 加密环境变量存储，代码中无任何硬编码。密码认证使用 SHA-256 签名 + 24 小时过期机制。

### Q6：页面显示"账户: 0"怎么办？
访问 `/debug` 端点查看诊断信息，确认 `ACCOUNTS` JSON 格式正确，然后重新部署 Worker。

---

## 开源协议
基于 [MIT License](LICENSE)，在原项目 [Townwang/DnsheAutoRenew](https://github.com/Townwang/DnsheAutoRenew) 基础上修改。
