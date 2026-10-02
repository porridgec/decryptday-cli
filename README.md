# decryptday CLI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

decrypt.day 全自动命令行工具：提交解密请求 → 跟踪状态 → 下载 IPA，全程无需手动打开网页。
可由 AI agent（ZCode / Claude Code 等）通过 Bash 调用，也可在终端手动使用。

> [!WARNING]
> - 本工具仅用于**自动化你自己的账号**（decrypt.day 是依赖订阅捐赠维持的免费服务，
>   如果你常用请考虑 [Upgrade](https://decrypt.day/upgrade) 支持站长）
> - 使用前请阅读并遵守目标站点的服务条款；滥用可能导致账号受限，风险自负
> - `.profile/` 目录保存你的登录会话（等同于密码），**切勿分享或提交到 git**

> 📖 **完整文档见 [MANUAL.md](./MANUAL.md)**（命令详解、错误码速查、会话管理、FAQ）。本 README 仅作快速上手。

## 文档

- [MANUAL.md](./MANUAL.md) — 完整使用手册（命令、错误码、会话管理、FAQ）
- [docs/decrypt-day-flow.md](./docs/decrypt-day-flow.md) — decrypt.day 前端逆向与请求流程分析

## 原理

Playwright 驱动**真实 Chrome**（有头窗口）+ 持久化登录会话，模拟真实用户操作路径：

```
login 一次（Discord OAuth 授权）
  ↓ 会话保存在 .profile/
request:  /request 页填 App Store 链接 → Turnstile 自动通过 → POST 提交
status:   /my/requests 解析请求列表（new / in progress / done / rejected）
download: app 页对话框 → premier 行 "Download" → Verify 页 "Get download link"
          → 捕获 307 签名直链（/fs/dl/d/<versionId>/<文件名>?X-Amz-*，1h 有效）→ 下载
watch:    轮询对话框直到 premier 文件就绪，自动转入 download
```

## 环境要求

- macOS + 已安装 Google Chrome（工具用 `channel: "chrome"` 启动真实 Chrome）
- Node ≥ 18、playwright（全局 `npm i -g playwright` 即可，无需下载浏览器——用的是本机 Chrome）

## ⚠️ 为什么必须有头 Chrome

decrypt.day 的 Cloudflare 会直接拦截一切自动化指纹（实测 2026-10-01）：

| 客户端 | 结果 |
|---|---|
| curl / 纯 HTTP | 100% 被拦截（Attention Required） |
| Playwright 自带 Chromium（headless 和 headed） | 间歇或全部被拦截 |
| **本机真实 Chrome，有头窗口** | 稳定通过 ✓ |

所以运行时会弹出 Chrome 窗口，操作完成后自动关闭，属正常现象。**不要**在窗口里乱点，交给工具即可（login 命令除外）。

## 用法

```bash
cd decryptday-cli

# 1. 首次登录（唯一需要人工的步骤）：弹出浏览器 → 用 Discord 登录 → 工具自动检测并保存会话
node decryptday.mjs login

# 2. 之后全自动
node decryptday.mjs whoami                 # 确认登录/Premier 状态
node decryptday.mjs request https://apps.apple.com/us/app/xxx/id1234567890
node decryptday.mjs request id1234567890   # 也支持 app id 或 decrypt.day 链接
node decryptday.mjs status                 # 请求列表 + 状态（new/in_progress/done/rejected）
node decryptday.mjs download id1234567890 --out ./ipas
node decryptday.mjs watch id1234567890 --interval 120   # 每 2 分钟查一次，done 后自动下载

# 机器可读输出（agent 用）
node decryptday.mjs status --json
```

任意命令都支持 `--json`。`request` 支持 apps.apple.com 链接、`idXXXX`、decrypt.day app 链接三种输入。

## agent 调用约定

- 所有命令输出 JSON（`--json`）或键值行；`ok: true/false` 表示成败
- 常见错误码：`NOT_LOGGED_IN`（跑 login）、`APP_VERSION_EXISTS`（已请求过，直接 watch）、
  `NOT_DECRYPTED_YET`（还没解密完，跑 watch）、`CAPTCHA_FAILED`（重跑一次即可）、
  `SITE_DOWN`（my/requests 页面 500，站点问题，稍后重试）
- 下载文件落在 `--out` 目录（默认 `./ipas/`），签名词直链 1 小时内可复用

## 已知限制

- Turnstile token 一次性；同一 token 二次提交返回 `CAPTCHA_FAILED`
- `/app/<id>/dl/<fileId>` Verify 页只能从对话框进入，直接开 URL/F5 会被弹回 app 页（防热链）
- 免费直链有每日限额且需过广告检测；Premier 账号无此限制（`isPremier:true` 自动跳过）
- 付费 App 不支持解密
