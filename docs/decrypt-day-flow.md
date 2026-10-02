# Decrypt.day 全流程请求梳理

> 基于 2026-10-01 对 https://decrypt.day 前端（SvelteKit）的反编译分析与页面实测。
> 站点使用 Cloudflare Turnstile 人机验证（sitekey: `0x4AAAAAAAMESrNIX1v6kpoj`），所有写操作都是 SvelteKit form action（POST + FormData + 同源 Cookie）。

## 0. 账号体系

- 登录方式：Discord OAuth / Telegram OAuth / Login ID + 密码（`/login`）
- Discord 流程：`/login` → "Login with Discord" → discord.com 授权 → 回调 `/society/discord` → 种 session Cookie
- Premier（Starter Pack $2.99/月）权益：**No limit request Premier Link / Unlimited access Premier Link**、免广告
- 登录态页面数据里带 `isPremier`、`hasLogin`、`hasPremier`、`adblock`、`bot` 标志

## 1. 发起解密请求（两条路）

### 路线 A：/request 页面（用 App Store 链接）
1. 打开 `/request`，输入 App Store 链接（只支持 **免费** App，`https://apps.apple.com/xx/app/xxx/idXXXX`）
2. 点击 Request → 前端先跑 Turnstile（`turnstile.execute()`）拿 `token`
3. 请求：
   ```
   POST /request
   Content-Type: multipart/form-data
   Cookie: <session>

   url=https://apps.apple.com/...&token=<cf-turnstile-response>
   ```
4. 响应（SvelteKit form result）：
   - 成功：`{ success: true, where: "request", app: { appId, name, latest_version } }`
   - 已有人请求过：`error.code = "APP_VERSION_EXISTS"`（提示 already requested）
   - 未登录：页面直接提示 "You are not authorized to perform this action."
5. 成功提示：**"Decryption could take up to 24 hours or even longer. Please be patient."**，并让你去 `/my/requests` 查状态

### 路线 B：App 详情页（/app/idXXXX 的 Download 对话框）
当某版本还没有解密文件时，文件列表里会出现一个占位的 premium 行（`notes: "Request a premier link to download this file"`）：

```
POST /app/<appId>?/request
Content-Type: multipart/form-data

token=<cf-turnstile-token>&appId=<内部id>&id=<version id>&name=<版本号>
```

Premier 用户看到 "Request link" 按钮；免费用户这里显示 "Upgrade account"；未登录显示 "Need login"。

### 其他相关请求
```
GET  https://cdn.decrypt.day/resources/apps/indexed.json   # 全站搜索索引（客户端模糊搜索）
POST /app/<appId>?/files        # 取某版本的文件列表（body: data=<urlencoded 参数>，60s 防抖）
POST /logout                    # 退出登录
```

## 2. My Requests 查状态（/my/requests）

- 页面：`https://decrypt.day/my/requests`（请求成功后的提示里有直达链接）
- 数据来源：页面 GET 时服务端直接渲染 `data.requests[]`，每条含：
  `app_id`、`state`、`version`、`created_at`、`note`
- **状态机：`new` → `in_progress` → `done`（或 `rejected`）**
  - 徽章样式：`done`=primary、`in_progress`=warning、`rejected`=error、`new`=默认
  - 显示文字为 `state.replace(/_/g," ").toUpperCase()` → NEW / IN PROGRESS / DONE / REJECTED
  - `rejected` 会附 `note`（"Note: ..."）
- 页面加载后还会带 Turnstile 拉一次 app 元数据（图标/名字）：
  ```
  POST /my/requests?/apps
  token=<cf-turnstile-token>&apps=<逗号拼接的 app_id 列表>
  ```
- ⚠️ 页面**没有自动轮询**，状态变化需要刷新页面才能看到
- 每条记录点击后跳 `/app/<app_id>`，下载要回 App 页操作

## 3. done 之后用 Premier Link 下载

### 3.1 文件模型
`?/files` / 页面数据里的文件对象：
```json
{
  "id": "<fileId>",
  "version_id": "...",
  "storage_provider": "...-request | s3://... | r2://... | google.com | dropbox.com ...",
  "file_name": "...",
  "file_size_bytes": "0",
  "checksum": "...",
  "premium": true,
  "created_at": ..., "updated_at": ..., "deleted_at": ...,
  "notes": "..."
}
```
- `premium: true` = Premier Link（通常是刚解密完、放在自有存储 `-request`/s3/r2 的文件）
- Source 判定：provider 以 `request` 结尾或文件名以 `s3://`/`r2://` 开头 → 显示 "premium"，其余显示 Google Drive / OneDrive / Dropbox / Mega / Mediafire 等

### 3.2 下载步骤（Premier 用户）
1. `/my/requests` 看到该请求 **DONE** → 点进去到 `/app/<appId>`
2. 点 "Download for free"（按钮文案固定，实际就是打开下载对话框）
3. 对话框文件列表里，解密完成的文件那一行（黄色 premium 图标）显示 **"Download"** 按钮
   - Premier 行按钮分支：未登录 → "Need login"；非 Premier → "Upgrade account"；还在上传 → "Updating..."（并按 app 大小估算 "might be ready ..." 时间）；可下载 → "Download"
4. 点击后进入 Verify Download 页：
   ```
   GET /app/<appId>/dl/<fileId>
   ```
   页面显示文件名、版本、大小、Source、Checksum
5. 点 "Get download link" → Turnstile 拿 token（Premier **跳过广告检测**，token 一到立刻提交；免费用户还要过一道 adblock 检测）：
   ```
   POST /app/<appId>/dl/<fileId>        # form action "verify"
   Content-Type: multipart/form-data

   token=<cf-turnstile-token>&hasher=<反爬指纹，可为空>
   ```
6. 响应：`{ success: true, where: "verify", url: "<签名下载直链>" }`
7. 按钮变成 "Download" → 点击 `window.open(url)` → IPA 开始下载

### 3.3 Premier 与免费的差别
| | 免费 | Premier |
|---|---|---|
| 获取链接 | 同一 verify 接口 | 同一接口 |
| 限制 | 免费直链有**每日限额**（页面明示 "The free link may have hit its daily limit"） | Unlimited / No limit |
| 广告检测 | 必须通过 adblock 检测（MutationObserver 检查 adsbygoogle 是否真实加载）+ 页面各处广告 | 完全跳过，token 到手即提交 |
| Premier 行 | 显示 "Upgrade account" | 显示 "Download" |

## 4. 登录态实测结果（2026-10-01，Premier 账号实测）

### 4.1 Premier 登录态下的 UI 变化（实测确认）
- App 页 Download 对话框：Premier 文件行直接显示 **"Download"** 按钮（未登录是 "Need login"，免费用户是 "Upgrade account"），"This is a Premier link..." 提示消失，对话框顶部广告消失
- `page.data.isPremier = true`

### 4.2 Verify 接口真实响应（实测抓包）
点击 "Get download link" 后（Turnstile 通过，Premier 跳过广告检测立即提交）：

```
POST /app/<appId>/dl/<fileId>          # form action
token=<cf-turnstile-token>&hasher=

→ 200 {"type":"redirect","status":307,
  "location":"https://decrypt.day/fs/dl/d/<versionId>/<file_name>?X-Amz-Expires=3600
   &X-Amz-Date=...&X-Amz-Signature=...&X-Amz-Credential=..."}   # AWS SigV4 预签名直链
```

- **Premier Link 本体 = `https://decrypt.day/fs/dl/d/<versionId>/<文件名>?X-Amz-*` 签名直链，有效期 1 小时（X-Amz-Expires=3600）**
- 前端拿到 redirect 后由 SvelteKit `applyAction` 发起导航，浏览器直接下载 IPA（页面 URL 不变）
- ⚠️ **Turnstile token 一次性**：同一 token 第二次提交返回 `{"type":"failure","code":"CAPTCHA_FAILED","message":"Your request is invalid. Please try again later."}`。想再拿一次直链必须重新跑 Turnstile

### 4.3 dl 下载页的导航限制（实测发现）
- `/app/<appId>/dl/<fileId>` **只能从 App 页对话框经客户端路由进入**（`history.replaceState`）
- 直接打开 URL / F5 刷新 / 新标签页打开 → 服务端/客户端会立即弹回 `/app/<appId>`（防热链设计，SSR HTML 本身正常）
- 但拿到的 `/fs/dl/d/...` 签名直链 1 小时内可任意使用

### 4.4 ？/files 响应结构（实测）
```
POST /app/<appId>?/files
→ {"success":true,"where":"files","data":{
     "files":[
       {"id":"C7n...","version_id":"njt3...","storage_provider":"request",
        "premium":true,"file_size_bytes":"1695075006","notes":"","login_required":false,
        "created_at":...,"updated_at":...,"deleted_at":null},
       {"id":"I0ce...","storage_provider":"www.jottacloud.com","premium":false,...}
     ],
     "canDownload":false}}
```
- `version_id` 就是签名直链路径里的 `<versionId>`
- 同一版本可同时有 premium 文件（自有存储 `request`）和免费镜像（jottacloud/google/dropbox 等）

### 4.5 实测时遇到的站点问题
- `/my/requests` 当时服务端持续 500（"Service temporarily unavailable"），其他登录页正常——是站点该页面临时故障，状态查看需要等恢复后刷新页面
- `/my`（Profile 总览页）显示 "Under Construction"

## 6. 实用结论（Premier 用户日常操作）

1. 请求解密：`/request` 贴 App Store 链接，或在 App 页对话框点 "Request link"
2. 查状态：`/my/requests` 刷新页面看 NEW → IN PROGRESS → DONE
3. 下载：App 页 → "Download for free" → premier 行点 "Download" → Verify 页点 "Get download link" → 自动开始下载
4. 想复用直链：点过 Get download link 后抓到的 `/fs/dl/d/<versionId>/<文件名>?X-Amz-*` 在 1 小时内有效，可直接 wget/curl/下载工具使用
5. 重复获取直链会消耗新的 Turnstile token，刷新页面即可重新走流程

## 7. 请求清单（速查）

| # | 方法 & 路径 | Body | 用途 |
|---|---|---|---|
| 1 | `GET /home` `/apps` `/app/<id>` `/my/requests` ... | - | SvelteKit SSR 页面，数据内嵌 |
| 2 | `POST /request` | `url`, `token` | 用 App Store 链接发请求 |
| 3 | `POST /app/<appId>?/request` | `token`, `appId`, `id`, `name` | 从 App 页对指定版本发请求 |
| 4 | `POST /app/<appId>?/files` | `data=<urlencoded>` | 取版本文件列表 |
| 5 | `POST /my/requests?/apps` | `token`, `apps` | 拉请求列表的 app 元数据 |
| 6 | `POST /app/<appId>/dl/<fileId>` | `token`, `hasher` | verify：换取签名下载直链 |
| 7 | `GET https://cdn.decrypt.day/resources/apps/indexed.json` | - | 搜索索引 |
| 8 | `POST /my/library?/token` | `token` | 生成 PlayCover 源 token（`/integrated/playcover/<token>`） |
| 9 | `POST /logout` | - | 退出 |

注意事项：
- 所有 POST 需要同源 Cookie（session）+ Cloudflare Turnstile token，脚本化需要先过 Turnstile
- 付费 App 不支持解密；重复请求返回 `APP_VERSION_EXISTS`，不会提醒
- 解密耗时官方口径：最长 24 小时甚至更久
