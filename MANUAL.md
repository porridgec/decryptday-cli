# decryptday CLI 使用手册

> decrypt.day 全自动工具：提交解密请求 → 跟踪状态 → 下载 IPA，全程无需手动操作网页。
> 适用版本：2026-10-01 · 配套流程文档见上级目录 `decrypt-day-flow.md`

---

## 1. 它是什么

一个命令行工具（`decryptday.mjs`，已装为全局命令 `decryptday`），用 Playwright 驱动**你本机的真实 Chrome**，以真实用户路径完成 decrypt.day 的全部操作：

```
登录（一次） ──► request 提交解密请求 ──► watch 轮询等待 ──► download 自动下载 IPA
                    │                        │
                    └── status 查看请求列表 ◄──┘（可随时查看）
```

可以手动在终端使用，也可以由 agent（ZCode 等）通过 Bash 调用。

---

## 2. 环境要求

| 依赖 | 要求 | 说明 |
|---|---|---|
| macOS + Google Chrome | 必须已安装 | 工具用 `channel: "chrome"` 启动本机真实 Chrome |
| Node.js | ≥ 18 | |
| playwright | `npm i -g playwright` | 只用它的驱动能力；**无需** `playwright install chromium`（用的是本机 Chrome，误装也不影响） |

### ⚠️ 为什么必须弹出 Chrome 窗口

decrypt.day 的 Cloudflare 会按客户端指纹封锁自动化访问（2026-10-01 实测）：

| 客户端 | 结果 |
|---|---|
| curl / 纯 HTTP | 100% 拦截（Attention Required） |
| Playwright 自带 Chromium（有头/无头） | 拦截 |
| 真实 Chrome 无头模式 | 拦截 |
| **真实 Chrome 有头窗口** | **稳定通过 ✓** |

因此运行时会弹出 Chrome 窗口、操作完自动关闭，属正常现象。**窗口弹出期间请勿手动操作页面**（`login` 命令除外，那个窗口就是给你用的）。

---

## 3. 快速开始

```bash
# 1. 首次登录（唯一需要人工的步骤）
decryptday login
#    → 弹出 Chrome → 用 Discord/Telegram/账号密码登录
#    → 工具被动检测到成功后输出 {"ok": true, "isPremier": true, ...} 并自动关窗

# 2. 提交解密请求
decryptday request https://apps.apple.com/us/app/xxx/id1234567890

# 3. 挂机等待解密完成并自动下载（默认每 60 秒查一次，最长等 24 小时）
decryptday watch id1234567890

# 4. 或手动分步
decryptday status                     # 查状态
decryptday download id1234567890      # 就绪后直接下载
```

IPA 保存位置：`--out` 指定的目录；不传则为**运行命令时所在目录**下的 `ipas/`。

---

## 4. 命令详解

### 4.1 `decryptday login` — 首次登录 / 会话续期

```bash
decryptday login
```

- 打开 /home，未登录则转到登录页；之后**完全被动观察**，绝不干扰你的操作（Discord OAuth 跳转、弹窗都能正确跟踪）
- 检测到任意 decrypt.day 页面呈已登录状态即成功，会话写入 `.profile/`
- 等待上限 10 分钟，超时输出 `LOGIN_TIMEOUT`
- **重新登录成本很低**：profile 里保留着 Discord 登录态，通常只需点一次授权

输出示例：
```
ok: true
loggedIn: true
isPremier: true
profile: /path/to/decryptday-cli/.profile
```

### 4.2 `decryptday whoami` — 查看账号状态

```bash
decryptday whoami
```

返回 `loggedIn` 和 `isPremier`。任何疑虑先跑这个。

### 4.3 `decryptday request <输入>` — 提交解密请求

```bash
decryptday request https://apps.apple.com/us/app/wuthering-waves/id6475033368
decryptday request id6475033368
decryptday request https://decrypt.day/app/id6475033368
```

三种输入均可：App Store 链接 / `idXXXX` / decrypt.day app 链接（只支持**免费** App）。

内部流程：若给的是 id，先到 app 页抓取 App Store 链接 → 打开 `/request` 填入 → 点 Request（Turnstile 自动通过）→ 等待提交结果（最长 60 秒）。

| 结果 | 含义 | 下一步 |
|---|---|---|
| `ok: true` | 请求创建成功 | 跑 `watch` 挂机等下载 |
| `APP_VERSION_EXISTS` | 该版本已被请求过 | 直接 `watch` |
| `NOT_LOGGED_IN` | 会话失效 | `decryptday login` |
| `MAINTENANCE` | 站点维护中 | 稍后再试 |

> 官方口径：解密最长 **24 小时甚至更久**；重复请求不会有提醒。

### 4.4 `decryptday status` — 查看我的请求

```bash
decryptday status
```

> 路径说明：`/my/requests` **文档级直开会 500**（站点 SSR 问题），本命令走
> home → 右上角圆形 US 按钮 → "My requests" 的站内客户端路由（2026-10-01 修复）。

解析 `/my/requests` 页面，返回请求列表：

```
- state: done            # new / in_progress / done / rejected
  appName: XXX
  appId: idXXXX
  raw: ...               # 原始文本（含版本、请求时间、Note）
```

- `rejected` 的原因显示在 `raw` 的 Note 里
- 若连菜单路径都异常才报 `SITE_DOWN` / `PAGE_ERROR`；备选跟踪手段是 `watch`（完全不依赖该页面）

### 4.5 `decryptday download <输入>` — 下载 IPA

```bash
decryptday download id1234567890 --out ./ipas
```

内部流程：
1. 打开 app 页 → 点 "Download for free" 打开对话框
2. **版本校验**：对话框版本 vs request 时登记的版本（不一致报 `VERSION_MISMATCH`，`--force` 跳过）
3. **下载来源策略（premier 永远优先，免费仅兜底）**：
   - premier 行 **"Download"（就绪）** → 点击 → Verify 页 → 换签名直链 → 下载（`source: "premier"`）
   - premier 行 **"Request link"（请求 DONE 后的正常状态）** → 自动点击**触发 premier 链接生成** → 每 30 秒复查，默认等 10 分钟（`--wait` 可调）→ 就绪后下载
   - premier 行 **"Updating..."** → 同上等待
   - ⚠️ 即使免费镜像已可用，也先走 premier 生成流程；免费镜像**只在 premier 等待超时后**兜底（输出 `source: "free"` 并在日志注明）
4. 签名直链两种形态均支持：`redirect`（`/fs/dl/d/...`，1h，页面会自动导航并可能被关闭）与 `success+url`（`/fs/dl/s/...`，30min，需点页面 Download 按钮）；下载优先浏览器事件，兜底 curl（带 Cookie，断点续传）
5. **文件传输（2026-10-02 定稿 v2）**：手动下载走浏览器下载管理器（弹系统选择器），自动化下 Chrome 会在下载提交时**崩溃退出**（macOS 弹 "Chrome quit unexpectedly"）。工具对策：**CDP Fetch 在响应阶段拦截 /fs/dl/ 的 302 → 读出 R2 存储直链 → 假 200 截胡（浏览器永不提交下载、零崩溃）→ Node 流式下载 R2 直链**（带进度日志）；外链镜像走浏览器下载事件 / curl 兜底

| 结果 | 含义 | 下一步 |
|---|---|---|
| `ok: true`（含 file/size/version/source） | 下载完成 | — |
| `VERSION_MISMATCH` | 对话框版本 ≠ 期望版本 | 确认后 `--version` 下旧版或 `--force` |
| `PREMIER_LINK_TIMEOUT` | 触发生成后等待超时 | 稍后重跑（生成会继续）|
| `CAPTCHA_FAILED` | Turnstile token 被重复消费 | 直接重跑一次 |
| `VERIFY_FAILED` | 未拿到签名直链（含 dump 诊断） | 重跑一次 |
| `NOT_PREMIER` | 当前账号不是 Premier | 升级账号 |

### 4.6 `decryptday watch <输入>` — 挂机等待并自动下载

```bash
decryptday watch id1234567890 --interval 120 --timeout 86400 --out ./ipas
```

- `--interval`：轮询间隔秒数（默认 60）
- `--timeout`：总等待上限秒数（默认 86400 = 24 小时）
- 每轮打开浏览器检查对话框状态并**自动推进**：
  - `requestable`（DONE 后 premier 链接未生成）→ 自动点击 "Request link" 触发生成（10 分钟冷却防重复点击）
  - `in_progress`（生成中）→ 继续等
  - `ready` / `ready_free` → 自动执行 download（premier 优先，免费镜像兜底）
- 版本校验贯穿全程（与 request 登记版本比对）
- 遇到 `need_login` / `not_premier` / `none` / 页面异常会**中止**（避免无意义死循环）

典型用法：白天 `request`，晚上挂 `watch`，早上 IPA 已在 `./ipas/`。

---

## 5. 全局选项

| 选项 | 说明 |
|---|---|
| `--json` | 输出 JSON（agent/脚本解析用；不加以键值行输出） |
| `--out <目录>` | download/watch 的保存目录。**默认为「运行命令时所在目录」下的 `ipas/`**（即 shell 当前目录，不是脚本所在目录）——例如在 home 下运行则落在 `~/ipas/`。路径不存在会自动创建 |
| `--interval <秒>` | watch 轮询间隔（默认 60） |
| `--timeout <秒>` | watch 总时长上限（默认 86400） |

---

## 6. 会话与有效期

| 项目 | 有效期 | 说明 |
|---|---|---|
| 站点会话 cookie（`d3.ss`） | **3 天**（登录时固定，非滑动续期） | 过期后一切命令报 `NOT_LOGGED_IN` |
| Cloudflare 放行（`cf_clearance`） | 365 天 | 绑定 IP + 浏览器指纹；换网络可能触发重新验证（有头 Chrome 自动通过） |

- 会话失效不用记时间，报 `NOT_LOGGED_IN` 时跑 `decryptday login` 即可
- 会话存储在 `decryptday-cli/.profile/`，**等同于登录凭据**：不要分享、不要提交到 git（`.gitignore` 已排除）
- 自定义位置：环境变量 `DECRYPTDAY_PROFILE=/path/to/dir`
- 并发注意：profile 同时只能被一个命令占用（Chrome 进程锁）。工具遇到残留锁会自动清理重试；但**不要同时跑两个 decryptday 命令**

---

## 7. 错误码速查

| 错误码 | 含义 | 处理 |
|---|---|---|
| `NOT_LOGGED_IN` | 会话失效/未登录 | `decryptday login` |
| `NOT_PREMIER` | 账号非 Premier，文件是 Premier Link | 升级账号 |
| `NOT_DECRYPTED_YET` | 尚无解密完成的文件 | 先 `request`，再 `watch` |
| `IN_PROGRESS` | 文件解密完在上传中 | 稍后重跑 |
| `APP_VERSION_EXISTS` | 该版本已被请求过 | 直接 `watch` |
| `CAPTCHA_FAILED` | Turnstile token 一次性，被重复消费 | 直接重跑一次 |
| `VERSION_MISMATCH` | 对话框版本与请求版本不一致 | `--version <旧版>` 显式下载或 `--force` |
| `PREMIER_LINK_TIMEOUT` | 触发生成后 premier 链接等待超时 | 稍后重跑或加 `--wait` |
| `VERIFY_FAILED` | 未获取到签名直链 | 重跑一次；持续失败看 detail |
| `SITE_DOWN` | my/requests 渲染异常（罕见，status 已走菜单路径） | 重试；或用 `watch` 替代 |
| `MAINTENANCE` | 站点维护中 | 稍后再试 |
| `NO_FILE` | 该版本无任何可下载文件 | — |
| `TIMEOUT` | 60 秒内未收到提交结果 | 重跑 |
| `LOGIN_TIMEOUT` | 10 分钟内未完成登录 | 重跑 `login` |
| `USAGE` / `INVALID_INPUT` | 参数问题 | 按提示修正 |
| `CRASH` | 程序异常 | 把 message 内容反馈排查 |

---

## 8. FAQ

**Q: 为什么每次都会弹 Chrome 窗口？能不能无头？**
不能。Cloudflare 对无头/自动化指纹是硬封锁（见第 2 节实测表），有头真实 Chrome 是唯一稳定通道。窗口存活时间通常 10–40 秒（download 视文件大小）。

**Q: 签名直链能手动用吗？**
`/fs/dl/...` 直链只在真实浏览器里有效（Cloudflare 按 TLS 指纹拦截 curl/Node，返回 403）；但它 302 指向的 `r2.cloudflarestorage.com` 存储直链可以直接用 curl/wget/下载工具（签名授权、无 bot 检测），有效期约 30 分钟-1 小时、支持断点续传。CLI 输出的 `url` 字段就是 R2 直链。

**Q: 能下载免费链接（Google Drive 等镜像）吗？**
工具固定走 Premier Link 路径（无每日限额、免广告检测）。免费链接有每日限额且需要通过广告检测，未实现。

**Q: request 之后要等多久？**
官方口径最长 24 小时甚至更久。建议 `request` 后直接挂 `watch --interval 120`，done 会自动下载。

**Q: watch 一晚上会不会掉登录？**
不会。会话 3 天有效，watch 单次最长默认 24 小时。

**Q: 弹出的窗口报 Cloudflare 拦截 / Turnstile 600010？**
600010 已通过去除 Chrome 自动化标志修复。若再现：确认没有同时开第二个 decryptday 命令；确认 Chrome 正常启动；重跑一次。

**Q: 报 ProcessSingleton / profile 被锁？**
工具会自动清理残留进程并重试。仍失败就手动关掉弹出的 Chrome 窗口再跑。

---

## 9. 文件结构

```
decryptday-cli/
├── decryptday.mjs   # 主程序（单文件，无第三方依赖，playwright 走全局）
├── MANUAL.md        # 本手册
├── README.md        # 快速上手
├── .gitignore       # 排除 .profile/、ipas/、.requests-state.json
├── .profile/        # Chrome 持久化会话（含登录凭据，勿外传）
├── .requests-state.json  # request 登记的 appId→版本映射（版本校验依据）
└── ipas/            # 默认下载目录（随 --out 变化）
```

## 10. agent 调用约定（供 ZCode 等使用）

- 一律加 `--json` 解析输出，以 `ok` 字段判断成败
- 标准自动化序列：`whoami` → `request` → `watch`（长轮询）→ 收 `ok:true` + 文件路径
- `status` 已走 US 菜单客户端路由（直开 URL 会 500）；仍异常时用 `watch` 的轮询状态替代
- 同一时间只运行一个 decryptday 命令（profile 锁）
- 命令执行期间用户屏幕会弹出 Chrome，属预期行为，无需处理
