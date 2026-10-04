#!/usr/bin/env node
// decryptday CLI — 全自动提交解密请求 / 查状态 / 下载 IPA
// 依赖: playwright (全局或本地), Chromium; 会话持久化在 .profile 目录
// 用法见 README.md

import { createRequire } from "node:module";
import { existsSync, mkdirSync, statSync, rmSync } from "node:fs";
import * as fsSync from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

// 跟随符号链接解析真实位置（全局命令也能正确定位 .profile）
const __dirname = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
const PROFILE_DIR = process.env.DECRYPTDAY_PROFILE || path.join(__dirname, ".profile");
const BASE = "https://decrypt.day";
// 重要: 必须用有头真实 Chrome（channel:"chrome"）。Playwright 自带 Chromium 的 headless/headful
// 指纹和 curl 都会被 decrypt.day 的 Cloudflare 直接拦截（实测 2026-10-01）。


// ---------- playwright 解析：本地 -> 全局 ----------
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {}
  const globalPaths = [
    "/opt/homebrew/lib/node_modules/playwright/index.mjs",
    "/usr/local/lib/node_modules/playwright/index.mjs",
  ];
  for (const p of globalPaths) {
    if (existsSync(p)) return await import(p);
  }
  const require = createRequire(import.meta.url);
  try {
    return { chromium: require("playwright").chromium };
  } catch {
    console.error("找不到 playwright。请先: npm i -g playwright && playwright install chromium");
    process.exit(1);
  }
}

// ---------- 输出 ----------
let JSON_OUT = false;
const out = (obj) => console.log(JSON_OUT ? JSON.stringify(obj, null, 2) : pretty(obj));
function pretty(v) {
  if (v === null || typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map((x) => "- " + pretty(x).replace(/\n/g, " ")).join("\n");
  return Object.entries(v)
    .map(([k, val]) => {
      const s = typeof val === "object" ? JSON.stringify(val) : String(val);
      return `${k}: ${s}`;
    })
    .join("\n");
}
const log = (msg) => console.error(msg);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") JSON_OUT = true;
    else if (a === "--out" || a === "--interval" || a === "--timeout" || a === "--wait" || a === "--version")
      args[a.slice(2)] = argv[++i];
    else if (a === "--force") args.force = true;
    else args._.push(a);
  }
  return args;
}

// ---------- 浏览器 ----------
async function withBrowser(opts = {}, fn) {
  const { chromium } = await loadPlaywright();
  mkdirSync(PROFILE_DIR, { recursive: true });
  const launch = () =>
    chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      viewport: { width: 1366, height: 900 },
      acceptDownloads: true,
      // 去掉自动化标志，否则 Cloudflare Turnstile 报 600010 拒绝执行
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    });
  let ctx;
  try {
    ctx = await launch();
  } catch (e) {
    const msg = String(e);
    if (/Executable doesn't exist/.test(msg)) {
      console.error("Chromium 未安装，正在安装: playwright install chromium");
      const { status } = await run("playwright", ["install", "chromium"], { stdio: "inherit" });
      if (status !== 0) process.exit(status ?? 1);
      ctx = await launch();
    } else if (/ProcessSingleton|SingletonLock/.test(msg)) {
      log("profile 被残留的浏览器进程占用，正在清理后重试...");
      await run("pkill", ["-f", `user-data-dir=${PROFILE_DIR}`]);
      await sleep(2000);
      for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
        rmSync(path.join(PROFILE_DIR, f), { force: true });
      ctx = await launch();
    } else throw e;
  }
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.setDefaultTimeout(30_000);
    return await fn(page, ctx);
  } finally {
    await ctx.close().catch(() => {});
  }
}

// 请求状态记录：appId -> { version, requestedAt }，供 watch/download 校验版本
const STATE_FILE = path.join(__dirname, ".requests-state.json");
function readState() {
  try { return JSON.parse(existsSync(STATE_FILE) ? fsSync.readFileSync(STATE_FILE, "utf8") : "{}"); }
  catch { return {}; }
}
function writeState(state) {
  try { fsSync.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

function run(cmd, args, o = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: o.stdio || "pipe", ...o });
    p.on("close", (code, signal) => resolve({ status: code ?? (signal ? 1 : 0) }));
    p.on("error", () => resolve({ status: 1 }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function goto(page, url, { wait = 2500 } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(wait);
}

// 响应监听：捕获 decrypt.day 的 form action POST 返回（默认 action 以 "?" 结尾，命名 action 含 "?/"）
function captureActions(page) {
  const captured = [];
  page.on("response", async (res) => {
    try {
      const req = res.request();
      if (req.method() !== "POST") return;
      const url = res.url();
      if (!url.startsWith(BASE)) return;
      if (url.includes("__data.json")) return;
      const pathAndQuery = url.slice(BASE.length);
      const isFormAction = pathAndQuery.endsWith("?") || /[?&]\/[a-z]+/.test(pathAndQuery);
      if (!isFormAction) return;
      const text = await res.text();
      if (!text.startsWith("{")) return;
      captured.push({ url, status: res.status(), body: JSON.parse(text), raw: text });
    } catch {}
  });
  return captured;
}

// 检查登录状态（带 Cloudflare 拦截重试）
async function checkAuth(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await goto(page, `${BASE}/home`, { wait: 2000 });
    const title = await page.title();
    if (/Cloudflare/i.test(title)) {
      log("被 Cloudflare 拦截，等待重试...");
      await page.waitForTimeout(5000);
      continue;
    }
    const rendered = (await page.locator('input[placeholder*="ind"]').count()) > 0;
    if (rendered) {
      const loginLink = await page.locator('a[href*="/login"]').count();
      const html = await page.content();
      return { loggedIn: loginLink === 0, isPremier: /isPremier:!0|isPremier:true/.test(html) };
    }
    log("页面疑似被 Cloudflare 拦截，等待重试...");
    await page.waitForTimeout(4000);
  }
  throw new Error("页面加载异常（被 Cloudflare 持续拦截，请稍后重试）");
}

// 被动检测登录态：遍历已打开页面，绝不导航（供 login 等待用户操作时使用）
async function checkAuthPassive(ctx) {
  for (const p of ctx.pages()) {
    try {
      const url = p.url();
      if (!url.startsWith(BASE)) continue;
      if (/\/login/.test(url)) return { loggedIn: false, isPremier: false, onLogin: true };
      const hasSearch = await p.locator('input[placeholder*="ind"]').count();
      if (hasSearch === 0) continue; // 挑站内已渲染页面
      const loginLink = await p.locator('a[href*="/login"]').count();
      const html = await p.content();
      return { loggedIn: loginLink === 0, isPremier: /isPremier:!0|isPremier:true/.test(html) };
    } catch {}
  }
  return null;
}

// 站点相对时间（"about 3 hours ago"）→ 近似绝对时间 ISO
function relToIso(text) {
  if (!text) return null;
  const m = text.match(/(\d+|a|an|less than a|about a)\s+(second|minute|hour|day|month|year)s?\s*ago/i);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const n = /a$|an$/.test(word) ? 1 : parseInt(m[1], 10) || 1;
  const mult = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, month: 2592000000, year: 31536000000 }[m[2].toLowerCase()];
  return new Date(Date.now() - n * mult).toISOString();
}

function extractAppId(input) {
  // 支持: idXXXX / decrypt.day app 链接 / apps.apple.com 链接
  const m =
    String(input).match(/id(\d{6,})/) ||
    String(input).match(/decrypt\.day\/app\/id(\d{6,})/) ||
    (String(input).match(/^(\d{6,})$/) ? [null, String(input)] : null);
  return m ? "id" + m[1] : null;
}

// 从 app 页拿 App Store 链接（用于 /request 提交）
async function getAppStoreUrl(page, appId) {
  await goto(page, `${BASE}/app/${appId}`);
  const link = page.locator('a[href*="apps.apple.com"]').first();
  if ((await link.count()) === 0) return null;
  return link.getAttribute("href");
}

// ---------- 命令: login ----------
async function cmdLogin() {
  console.error("已打开登录页，请在弹出的浏览器窗口中完成登录（Discord/Telegram/账号密码均可）。");
  console.error("登录期间本工具不会动你的浏览器，检测到登录成功后自动结束并保存会话。");
  await withBrowser({}, async (page, ctx) => {
    // 先打开 /home：已有会话则直接检测成功；未登录再转到登录页，之后完全被动观察
    await goto(page, `${BASE}/home`, { wait: 2000 }).catch(() => {});
    let guided = false;
    const deadline = Date.now() + 10 * 60_000;
    let lastLogged = "";
    while (Date.now() < deadline) {
      await sleep(2000);
      const st = await checkAuthPassive(ctx);
      if (st && st.loggedIn) {
        out({ ok: true, loggedIn: true, isPremier: st.isPremier, profile: PROFILE_DIR });
        return;
      }
      // 首次确认未登录且用户尚未自行离开 home 时，带去登录页（仅此一次）
      if (!guided && page.url() === `${BASE}/home`) {
        await goto(page, `${BASE}/login`, { wait: 1500 }).catch(() => {});
        guided = true;
      }
      const state = st ? (st.onLogin ? "登录页，等待你完成登录" : "在站内，未登录") : "站外（Discord OAuth 等）";
      if (state !== lastLogged) {
        log("等待登录中... 当前状态: " + state);
        lastLogged = state;
      }
    }
    out({ ok: false, error: "LOGIN_TIMEOUT", message: "10 分钟内未检测到登录成功" });
  });
}

// ---------- 命令: whoami ----------
async function cmdWhoami(args) {
  await withBrowser({ headless: args.headless }, async (page) => {
    const auth = await checkAuth(page);
    out({ ok: true, ...auth, profile: PROFILE_DIR });
  });
}

// ---------- 命令: request ----------
async function cmdRequest(args) {
  const target = args._[1];
  if (!target) return out({ ok: false, error: "USAGE", message: "request <apps.apple.com 链接 | idXXXX | decrypt.day app 链接>" });
  await withBrowser({ headless: args.headless }, async (page) => {
    const auth = await checkAuth(page);
    if (!auth.loggedIn) return out({ ok: false, error: "NOT_LOGGED_IN", message: "请先执行 login" });

    let appStoreUrl = target.includes("apps.apple.com") ? target : null;
    const appId = extractAppId(target);
    if (!appStoreUrl && appId) appStoreUrl = await getAppStoreUrl(page, appId);
    if (!appStoreUrl)
      return out({ ok: false, error: "INVALID_INPUT", message: "无法解析出 App Store 链接或 app id" });

    await goto(page, `${BASE}/request`);
    const input = page.locator('input[placeholder="Enter App Store URL..."]');
    if ((await input.count()) === 0) return out({ ok: false, error: "PAGE_ERROR", message: "request 页面加载异常" });
    await input.fill(appStoreUrl);

    const captured = captureActions(page);
    await page.locator('button:has-text("Request")').first().click();

    // 等 form action 返回（turnstile 自动执行，可能需要十几秒）
    const deadline = Date.now() + 60_000;
    let result = null;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);
      result = captured.find((c) => c.url.includes("/request"));
      if (result) break;
    }
    if (!result) {
      // 兜底：未登录时站点可能走原生表单跳转，检测页面文案
      const pageText = await page.locator("body").innerText().catch(() => "");
      if (pageText.includes("not authorized") || pageText.includes("log in first"))
        return out({ ok: false, error: "NOT_LOGGED_IN", message: "站点提示未登录，请先执行 login" });
      if (pageText.includes("maintenance"))
        return out({ ok: false, error: "MAINTENANCE", message: "站点维护中" });
      return out({ ok: false, error: "TIMEOUT", message: "60 秒内未收到提交结果" });
    }

    const b = result.body;
    const raw = result.raw || "";
    if (b.type === "success") {
      // 从 devalue 扁平数组里找 app.latest_version（站点实际登记的版本）
      let version = null, appId = null;
      try {
        const flat = JSON.parse(b.data);
        for (const item of flat) {
          if (item && typeof item === "object" && !Array.isArray(item) && "latest_version" in item) {
            version = flat[item.latest_version] ?? null;
            appId = item.appId ? `id${item.appId.replace(/\D/g, "")}` : null;
            break;
          }
        }
      } catch {}
      if (appId && version) {
        const state = readState();
        state[appId] = { version: String(version), requestedAt: new Date().toISOString() };
        writeState(state);
      }
      out({ ok: true, action: "requested", appId: appId ?? null, version, appStoreUrl, hint: "watch/download 会校验此版本；用 status 或 watch 跟踪进度" });
    } else if (b.type === "failure") {
      const code = raw.match(/\\?"([A-Z_]{5,})\\?"/)?.[1] ?? "UNKNOWN";
      out({
        ok: false,
        error: code,
        message:
          code === "APP_VERSION_EXISTS"
            ? "该版本已被请求过，等待解密即可（用 status 查看）"
            : "请求失败（可能 CAPTCHA_FAILED，重跑一次）",
        appStoreUrl,
      });
    } else {
      out({ ok: false, error: "UNEXPECTED", body: b });
    }
  });
}

// ---------- 命令: status ----------
// 注意: /my/requests 文档级直开会 500（站点 SSR 问题），必须走
// home → 右上角 US 按钮 → "My requests" 的客户端路由（2026-10-01 实测）
async function cmdStatus(args) {
  await withBrowser({}, async (page) => {
    const auth = await checkAuth(page);
    if (!auth.loggedIn) return out({ ok: false, error: "NOT_LOGGED_IN" });

    const us = page.getByRole("button", { name: "US" });
    if ((await us.count()) === 0)
      return out({ ok: false, error: "PAGE_ERROR", message: "home 页找不到 US 菜单按钮" });
    await us.hover();
    await page.waitForTimeout(800);
    await us.click();
    await page.waitForTimeout(1200);

    const myReq = page.getByText("My requests", { exact: true }).first();
    if ((await myReq.count()) === 0)
      return out({ ok: false, error: "PAGE_ERROR", message: "US 菜单中未找到 My requests 项" });
    await myReq.click();

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !page.url().includes("/my/requests"))
      await page.waitForTimeout(500);
    await page.waitForTimeout(3000);

    const html = await page.content();
    if (html.includes("Service temporarily unavailable"))
      return out({ ok: false, error: "SITE_DOWN", message: "my/requests 渲染异常，稍后重试" });

    const items = page.locator(".request-item");
    const n = await items.count();
    const requests = [];
    for (let i = 0; i < n; i++) {
      const el = items.nth(i);
      const badge = el.locator('[class*="dd-badge"]').first();
      const link = el.locator(".app-name a").first();
      const itemText = await el.innerText().catch(() => "");
      // 提交时间：站点原文（相对时间）+ 近似绝对时间
      let requestedAtText = null;
      try {
        const ra = el.locator("p.request-at").first();
        if ((await ra.count()) > 0) requestedAtText = (await ra.innerText()).replace(/^Request\s*/i, "").trim() || null;
      } catch {}
      // 版本：version 段落文本去掉徽章和 Note 部分
      let version = null;
      try {
        const vp = el.locator("p.version").first();
        if ((await vp.count()) > 0) {
          const badgeText = (await badge.count()) ? await badge.innerText() : "";
          version = (await vp.innerText())
            .replace(badgeText, "")
            .replace(/Note:[\s\S]*/i, "")
            .replace(/\s+/g, " ")
            .trim() || null;
        }
      } catch {}
      requests.push({
        state: (await badge.count()) ? (await badge.innerText()).trim().toLowerCase().replace(/\s+/g, "_") : null,
        appName: (await link.count()) ? (await link.innerText()).trim() : null,
        appId: (await link.count()) ? extractAppId((await link.getAttribute("href")) || "") : null,
        version,
        requestedAtText,
        requestedAt: relToIso(requestedAtText),
        raw: itemText.replace(/\n+/g, " | ").slice(0, 200),
      });
    }
    out({ ok: true, count: requests.length, requests });
  });
}

// ---------- 下载核心 ----------
// 打开对话框，分别检查 premier 行状态与免费行可用性（两个独立维度，不合并）
// 下载策略由调用方决定：premier 永远优先（requestable → 触发生成 → 等待），免费镜像仅兜底
async function inspectDialog(page) {
  // 防御：清掉可能残留的旧对话框（overlay 会拦截后续点击）
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
  const stale = page.locator('[role="dialog"] button:has-text("Close")');
  if ((await stale.count()) > 0) {
    await stale.first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
  const openBtn = page.locator('button:has-text("Download for free")');
  if ((await openBtn.count()) === 0) throw new Error("找不到 Download for free 按钮");
  await openBtn.first().click();
  await page.waitForTimeout(2000);
  const dlg = page.locator('[role="dialog"]');
  if ((await dlg.count()) === 0) throw new Error("下载对话框未出现");
  // 对话框标题形如 "Download 7.4.9"——本对话框展示的是该版本的文件
  let dialogVersion = null;
  try {
    const h = await dlg.locator("h2").first().innerText({ timeout: 3000 });
    dialogVersion = h.replace(/^Download\s*/i, "").trim() || null;
  } catch {}

  // premier 行状态
  let premierState = null, premierBtn = null;
  const premier = dlg.locator("button.btn-premier");
  const m = await premier.count();
  for (let i = 0; i < m; i++) {
    const t = (await premier.nth(i).innerText()).trim();
    if (t === "Download") { premierState = "ready"; premierBtn = premier.nth(i); break; }
  }
  if (!premierBtn) {
    for (let i = 0; i < m; i++) {
      const t = (await premier.nth(i).innerText()).trim();
      if (t === "Request link") { premierState = "requestable"; premierBtn = premier.nth(i); break; }
      if (t === "Updating...") { premierState = "in_progress"; break; }
      if (t === "Need login") { premierState = "need_login"; break; }
      if (t === "Upgrade account") { premierState = "not_premier"; break; }
    }
  }

  // 免费文件行（非 btn-premier 的 Download 按钮，可用状态）
  let freeBtn = null;
  const freeRows = dlg.locator("button.download:not(.btn-premier)");
  const fn = await freeRows.count();
  for (let i = 0; i < fn; i++) {
    const b = freeRows.nth(i);
    if ((await b.innerText()).trim() === "Download" && (await b.isEnabled())) { freeBtn = b; break; }
  }

  // 分别返回 premier 状态与免费可用性（不合并成单一 kind，避免免费行短路 premier 生成流程）
  return {
    premierState,                // ready | requestable | in_progress | need_login | not_premier | null(无 premier 行)
    premierButton: premierBtn,   // ready / requestable 时可点击
    freeReady: !!freeBtn,
    freeButton: freeBtn,
    dialogVersion,
  };
}

// 点击 "Request link" 触发 premier 链接生成
// （2026-10-01 用户确认：请求 DONE 后 premier 行仍显示 Request link 是正常的，
//   需再点击一次，站点会花时间生成 premier 下载链接）
async function triggerPremierLink(page, button, captured) {
  await button.click();
  const deadline = Date.now() + 60_000;
  let result = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    result = captured.find((c) => c.url.includes("/app/") && c.url.includes("/request"));
    if (result) break;
  }
  if (!result) return { triggered: true, note: "60s 内未捕获提交响应，生成可能仍在进行" };
  const raw = result.raw || "";
  const code = raw.match(/\\?"([A-Z_]{5,})\\?"/)?.[1] ?? null;
  // success（新建）与 APP_VERSION_EXISTS（已请求过）都算触发成功
  return { triggered: true, type: result.body.type, code: result.body.type === "success" ? "OK" : code };
}

// 在 dl 页点击 Get download link，返回签名直链
// 注意: redirect 形态会让站点导航到签名直链并开始下载，页面可能被关闭——
// 所以每轮必须先检查已捕获的响应再休眠，且休眠要对页面关闭容错
async function getSignedLink(page, captured, signedUrls = []) {
  const marker = { location: null, via: null, failure: null, dump: [], pageClosed: false };
  const deadline = Date.now() + 90_000;
  try {
    await page.locator('button:has-text("Get download link")').first().click();
  } catch (e) {
    marker.pageClosed = true;
  }
  const check = () => {
    // 形态0（最可靠）: 请求层同步捕获——站点导航/打开 /fs/dl/ 签名 URL 的 GET 请求。
    // 响应体读取会因下载导航关闭页面而丢失（2026-10-02 agent 实战踩坑），请求 URL 永不丢失
    if (signedUrls.length) {
      marker.location = signedUrls[signedUrls.length - 1];
      marker.via = marker.via || "nav";
      return true;
    }
    // 形态1: redirect（premier 自有存储 → /fs/dl/ 签名直链）
    const redirect = captured.filter((c) => c.body?.type === "redirect" && c.body.location);
    if (redirect.length) {
      marker.location = redirect[redirect.length - 1].body.location;
      marker.via = "redirect";
      return true;
    }
    // 形态2: success + url（devalue 数据里带直链，页面 Download 按钮 window.open 打开）
    const succ = captured.filter((c) => c.body?.type === "success" && c.body.data);
    for (const s of succ) {
      try {
        const flat = JSON.parse(s.body.data);
        for (const item of flat) {
          if (item && typeof item === "object" && !Array.isArray(item) && "url" in item && typeof flat[item.url] === "string") {
            marker.location = flat[item.url];
            marker.via = "success";
            return true;
          }
        }
      } catch {}
    }
    const fail = captured.filter((c) => c.body?.type === "failure");
    if (fail.length) marker.failure = fail[fail.length - 1].body; // 单次 failure 不中断（可能是重复提交的第二次）
    return false;
  };
  while (Date.now() < deadline) {
    if (check()) break;
    try {
      await page.waitForTimeout(1500);
    } catch {
      marker.pageClosed = true; // 页面因下载导航被关闭——captured 里可能已有结果
      break;
    }
  }
  if (!marker.location) check(); // 退出前最后查一次（captured 闭包数组在页面关闭后仍可读）
  marker.dump = captured.slice(-6).map((c) => ({
    url: c.url.slice(-60), type: c.body?.type ?? "?",
    code: String(c.raw || "").match(/\\?"([A-Z_]{5,})\\?"/)?.[1] ?? undefined,
    location: c.body?.location ? String(c.body.location).slice(0, 100) : undefined,
  }));
  return marker;
}

async function cmdDownload(args) {
  const target = args._[1];
  const outDir = args.out || path.join(process.cwd(), "ipas");
  if (!target) return out({ ok: false, error: "USAGE", message: "download <idXXXX | 链接> [--out 目录]" });
  mkdirSync(outDir, { recursive: true });

  await withBrowser({}, async (page, ctx) => {
    const auth = await checkAuth(page);
    if (!auth.loggedIn) return out({ ok: false, error: "NOT_LOGGED_IN", message: "请先执行 login" });
    if (!auth.isPremier)
      log("提示: 当前账号似乎不是 Premier，免费直链有每日限额且需过广告检测");

    const appId = extractAppId(target);
    if (!appId) return out({ ok: false, error: "INVALID_INPUT", message: "无法解析 app id" });

    const captured = captureActions(page);
    await goto(page, `${BASE}/app/${appId}`, { wait: 3000 });

    let dlg;
    try {
      dlg = await inspectDialog(page);
    } catch (e) {
      return out({ ok: false, error: "PAGE_ERROR", message: "app 页或下载对话框异常: " + String(e).slice(0, 120) });
    }

    // ---- 版本校验：期望版本 = --version 或 request 时记录的版本 ----
    const state = readState();
    const expected = args.version || state[appId]?.version || null;
    if (expected && !args.force && dlg.dialogVersion && dlg.dialogVersion !== expected) {
      return out({
        ok: false,
        error: "VERSION_MISMATCH",
        expected,
        dialogVersion: dlg.dialogVersion,
        message: `对话框当前是 ${dlg.dialogVersion} 的文件，期望 ${expected}（站点可能尚未更新到最新版本）。可用 --version ${dlg.dialogVersion} 显式下载旧版，或 --force 忽略校验`,
      });
    }
    if (expected && !args.force && !dlg.dialogVersion) {
      // 对话框标题解析失败——版本无法核对，显式警告而不是静默跳过
      log(`警告: 期望版本 ${expected} 但未能读取对话框版本号，本次下载不做版本校验`);
    }
    if (dlg.premierState === "need_login") return out({ ok: false, error: "NOT_LOGGED_IN" });
    if (dlg.premierState === "not_premier") return out({ ok: false, error: "NOT_PREMIER", message: "该文件是 Premier Link，当前账号无权限" });
    if (!dlg.premierState && !dlg.freeReady) return out({ ok: false, error: "NO_FILE", message: "该版本暂无任何可下载文件" });

    // 阶段1: premier 未就绪 → 触发生成（DONE 后点 Request link）并轮询等待。
    // 即使免费镜像已可用，也必须先走 premier 生成流程——免费仅作兜底（2026-10-01 修复）
    if ((dlg.premierState === "requestable" || dlg.premierState === "in_progress") && !args._skipPremierWait) {
      if (dlg.premierState === "requestable") {
        log("点击 Request link 触发 premier 链接生成...");
        const r = await triggerPremierLink(page, dlg.premierButton, captured);
        log("触发结果: " + JSON.stringify(r));
      } else {
        log("premier 链接生成中（Updating...），轮询等待...");
      }
      const waitMs = (parseInt(args.wait || "600", 10)) * 1000;
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await sleep(30_000);
        await goto(page, `${BASE}/app/${appId}`, { wait: 2500 });
        try { dlg = await inspectDialog(page); } catch { continue; }
        if (dlg.premierState === "ready") break;
        log(`等待 premier 链接生成... 剩余 ${Math.round((deadline - Date.now()) / 1000)}s（当前: ${dlg.premierState ?? "无 premier 行"}, 免费镜像: ${dlg.freeReady ? "有" : "无"}）`);
      }
    }

    // 阶段2: 选择下载来源——premier 优先，免费镜像仅在 premier 路径穷尽后兜底
    let source, dlButton;
    if (dlg.premierState === "ready") {
      source = "premier";
      dlButton = dlg.premierButton;
    } else if (dlg.freeReady) {
      source = "free";
      dlButton = dlg.freeButton;
      log("premier 链接未就绪，回退使用免费镜像下载（source=free）");
    } else {
      return out({
        ok: false,
        error: "PREMIER_LINK_TIMEOUT",
        dialogVersion: dlg.dialogVersion,
        message: `premier 链接等待 ${parseInt(args.wait || "600", 10)}s 后仍未就绪，且无免费镜像可兜底`,
        hint: "稍后重跑 download（生成会继续），或加 --wait 秒数延长等待",
      });
    }

    // 点击下载行 -> 进入 dl 页：premier 本页路由 / free 新标签（window.open）
    const popupPromise = ctx.waitForEvent("page", { timeout: 25_000 }).catch(() => null);
    await dlButton.click();
    let dlPage = page;
    const dlDeadline = Date.now() + 25_000;
    while (Date.now() < dlDeadline) {
      if (page.url().includes("/dl/")) { dlPage = page; break; }
      const pop = ctx.pages().find((p) => p !== page && p.url().includes("/dl/"));
      if (pop) { dlPage = pop; break; }
      await page.waitForTimeout(500);
    }
    if (dlPage === page && !page.url().includes("/dl/")) {
      const popup = await popupPromise;
      if (!popup) return out({ ok: false, error: "NAV_FAILED", message: "未能进入 Verify Download 页" });
      dlPage = popup;
      await dlPage.waitForLoadState("domcontentloaded").catch(() => {});
    }
    if (!dlPage.url().includes("/dl/")) return out({ ok: false, error: "NAV_FAILED", message: "未能进入 Verify Download 页" });
    await dlPage.waitForTimeout(2500);

    // ---- 下载执行（2026-10-02 定稿，源于用户关键线索）----
    // 手动点击 Get download link 会弹"系统文件夹选择器"（站点用 File System Access API 由
    // 页面 JS 拉流写盘），自动化走不通；且 verify 后站点导航到 /fs/dl/ 签名直链 → 302 → R2，
    // Chrome 在下载提交时整体崩溃退出（macOS 弹 "Chrome quit unexpectedly"）。
    // 零崩溃对策：CDP Fetch 在响应阶段拦截 /fs/dl/——302 一到就读出 Location（存储直链），
    // 用假 200 截胡，浏览器永不跟随重定向（零下载提交、零崩溃）；Node 直拉 R2 直链（R2 签名
    // 授权不做 bot 检测，Node fetch 可用；注意 /fs/dl/ 本身被 CF 指纹保护，Node 拉会 403）。
    let fsdlUrl = null;   // /fs/dl/ 签名直链（verify 响应里拿）
    let directUrl = null; // 存储直链（302 Location → R2）
    let fileName = null;
    ctx.on("close", () => log("（浏览器已关闭）"));

    // keeper 同源页（CDP 不可用时的兜底 fetch 通道）
    const keeper = await ctx.newPage().catch(() => null);
    if (keeper) await keeper.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" }).catch(() => {});

    // 主机制：CDP 响应阶段拦截
    let cdpOk = false;
    try {
      const cdp = await ctx.newCDPSession(dlPage);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*fs/dl*", requestStage: "Response" }] });
      cdp.on("Fetch.requestPaused", async (evt) => {
        try {
          const headers = evt.responseHeaders || [];
          const loc = headers.find((h) => h.name.toLowerCase() === "location")?.value;
          if (loc && !directUrl) {
            directUrl = loc;
            try {
              const f = decodeURIComponent(new URL(evt.request.url).pathname.split("/").pop());
              if (f && f.endsWith(".ipa")) fileName = f;
            } catch {}
            log("已从 302 截获存储直链（浏览器不会提交下载，无崩溃）");
          }
        } catch {}
        await cdp.send("Fetch.fulfillRequest", {
          requestId: evt.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
          body: Buffer.from("intercepted by decryptday-cli").toString("base64"),
        }).catch(() => {});
      });
      cdpOk = true;
    } catch (e) {
      log("CDP 响应拦截不可用（" + String(e).slice(0, 60) + "）");
    }

    const signedUrls = [];
    ctx.on("request", function onReq2(req) {
      try {
        const u = req.url();
        if (u.includes("/fs/dl/") && u.includes("X-Amz-")) signedUrls.push(u);
      } catch {}
    });
    const downloadPromise = ctx.waitForEvent("download", { timeout: 120_000 }).catch(() => null);
    const verifyCaptured = captureActions(dlPage);
    const linkPromise = getSignedLink(dlPage, verifyCaptured, signedUrls);

    // 等待存储直链（CDP 截获）或 /fs/dl/ 链接（verify 响应），最长 90 秒
    const linkStart = Date.now();
    while (!directUrl && Date.now() - linkStart < 90_000) {
      if (!fsdlUrl) {
        const hit = verifyCaptured.find((c) => c.body?.type === "redirect" && String(c.body.location || "").includes("/fs/dl/"));
        if (hit) fsdlUrl = hit.body.location;
      }
      if (directUrl) break;
      await sleep(300);
    }

    let savedPath = null;
    let finalUrl = null;
    if (directUrl) {
      // 拿到直链后优雅关闭浏览器（下载从未提交，无崩溃弹窗），Node 流式下载
      try { await ctx.close(); } catch {}
      if (!fileName) {
        try { fileName = decodeURIComponent(new URL(fsdlUrl || directUrl).pathname.split("/").pop()); } catch {}
      }
      savedPath = path.join(outDir, fileName || "app.ipa");
      finalUrl = directUrl;
      log(`Node 流式下载 ${fileName}...`);
      const res = await fetch(directUrl).catch(() => null);
      if (!res || !res.ok) {
        return out({ ok: false, error: "DOWNLOAD_FAILED", status: res ? res.status : 0, url: directUrl.slice(0, 140) });
      }
      const total = +(res.headers.get("content-length") || 0);
      const { createWriteStream } = await import("node:fs");
      const ws = createWriteStream(savedPath);
      const reader = res.body.getReader();
      let received = 0, lastPct = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        ws.write(value);
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct >= lastPct + 10) { log(`  进度 ${pct}%（${(received / 1024 ** 2).toFixed(0)}/${(total / 1024 ** 2).toFixed(0)} MB）`); lastPct = pct; }
        }
      }
      await new Promise((r) => ws.end(r));
    } else if (fsdlUrl && keeper && !keeper.isClosed()) {
      // CDP 拦截未生效的兜底：keeper 同源页 fetch（可能因 CORS 失败）
      const r2 = await keeper.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: "include" });
          return { ok: r.ok, status: r.status, finalUrl: r.url };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }, fsdlUrl).catch(() => null);
      if (!r2 || !r2.ok || !r2.finalUrl) {
        return out({ ok: false, error: "FETCH_VIA_KEEPER_FAILED", detail: r2, hint: "重跑一次 download" });
      }
      try { await ctx.close(); } catch {}
      const fname = decodeURIComponent(new URL(fsdlUrl).pathname.split("/").pop());
      savedPath = path.join(outDir, fname);
      finalUrl = r2.finalUrl;
      log("Node 流式下载...");
      const res = await fetch(r2.finalUrl).catch(() => null);
      if (!res || !res.ok) return out({ ok: false, error: "DOWNLOAD_FAILED", status: res ? res.status : 0 });
      const total = +(res.headers.get("content-length") || 0);
      const { createWriteStream } = await import("node:fs");
      const ws = createWriteStream(savedPath);
      const reader = res.body.getReader();
      let received = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; received += value.length; ws.write(value); }
      await new Promise((r) => ws.end(r));
      log(`  已下载 ${(received / 1024 ** 2).toFixed(0)} MB`);
    } else {
      // 兜底：非 /fs/dl/ 链接（外链镜像）——浏览器下载事件 / curl
      const link = await linkPromise;
      if (!dlPage.isClosed() && link?.via === "success") {
        const finalBtn = dlPage.locator('button:has-text("Download")').first();
        if ((await finalBtn.count()) > 0) await finalBtn.click().catch(() => {});
      }
      let download = await downloadPromise;
      let cookieHeader = "";
      try {
        cookieHeader = (await ctx.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join("; ");
      } catch {}
      if (download) {
        const fname = download.suggestedFilename() || "app.ipa";
        savedPath = path.join(outDir, fname);
        try {
          await download.saveAs(savedPath);
        } catch (e) {
          log("浏览器下载保存失败（" + String(e).slice(0, 80) + "），改用 curl...");
          download = null;
        }
      }
      if (!download) {
        if (!link?.location) {
          return out({ ok: false, error: "VERIFY_FAILED", detail: link?.failure ?? "未获取到任何下载直链", dump: link?.dump, hint: "若为 CAPTCHA_FAILED，重跑一次本命令" });
        }
        finalUrl = link.location;
        const fname = decodeURIComponent(new URL(link.location).pathname.split("/").pop());
        savedPath = path.join(outDir, fname);
        log("使用 curl 下载外链镜像...");
        const r = await run("curl", ["-L", "--fail", "-C", "-", "-H", `Cookie: ${cookieHeader}`, "-o", savedPath, link.location], { stdio: "inherit" });
        if (r.status !== 0) return out({ ok: false, error: "DOWNLOAD_FAILED", url: link.location });
      }
    }

    const size = statSync(savedPath).size;
    out({
      ok: true,
      file: savedPath,
      size,
      sizeHuman: (size / 1024 ** 3).toFixed(2) + "GB",
      version: dlg.dialogVersion,
      source,
      via: cdpOk && directUrl ? "cdp-intercept+node-stream" : fsdlUrl ? "keeper-fetch" : "browser",
      signedUrlValidFor: finalUrl && String(finalUrl).includes("X-Amz-Expires=3600") ? "1h" : "30min",
      url: String(finalUrl).slice(0, 120) + "...",
    });
  });
}

// ---------- 命令: watch ----------
// 轮询 app 页对话框，等 premier 文件就绪后自动下载
async function cmdWatch(args) {
  const target = args._[1];
  const interval = (parseInt(args.interval || "60", 10)) * 1000;
  const timeout = (parseInt(args.timeout || "86400", 10)) * 1000;
  if (!target) return out({ ok: false, error: "USAGE", message: "watch <idXXXX | 链接> [--interval 60] [--timeout 86400] [--out 目录]" });

  const deadline = Date.now() + timeout;
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount++;
    const res = await withBrowser({}, async (page) => {
      const auth = await checkAuth(page).catch(() => ({ loggedIn: false }));
      if (!auth.loggedIn) return { ok: false, error: "NOT_LOGGED_IN" };
      const appId = extractAppId(target);
      if (!appId) return { ok: false, error: "INVALID_INPUT" };
      await goto(page, `${BASE}/app/${appId}`, { wait: 3000 });
      const dlg = await inspectDialog(page).catch((e) => ({ premierState: "error", freeReady: false, message: String(e), dialogVersion: null }));
      // DONE 后 premier 行显示 "Request link" 属正常——需点击触发生成（10 分钟冷却防重复点击）
      let triggered = false;
      try {
        const st0 = readState();
        const expected0 = args.version || st0[appId]?.version || null;
        const mismatch0 = expected0 && dlg.dialogVersion && dlg.dialogVersion !== expected0;
        if (dlg.premierState === "requestable" && !mismatch0 && dlg.premierButton) {
          const last = st0[appId]?.linkRequestedAt ? Date.parse(st0[appId].linkRequestedAt) : 0;
          if (Date.now() - last > 10 * 60_000) {
            const captured = captureActions(page);
            const r = await triggerPremierLink(page, dlg.premierButton, captured).catch(() => null);
            st0[appId] = { ...(st0[appId] || {}), linkRequestedAt: new Date().toISOString() };
            writeState(st0);
            triggered = true;
            log("已点击 Request link 触发 premier 链接生成: " + JSON.stringify(r ?? {}));
          }
        }
      } catch {}
      return { premierState: dlg.premierState ?? null, freeReady: !!dlg.freeReady, appId, dialogVersion: dlg.dialogVersion ?? null, triggered };
    });

    if (res.ok === false) return out(res);
    const state = readState();
    const expected = args.version || state[res.appId]?.version || null;
    const mismatch = expected && res.dialogVersion && res.dialogVersion !== expected;
    log(`[poll #${pollCount}] premier: ${res.premierState ?? "无"}, 免费镜像: ${res.freeReady ? "有" : "无"}, 版本: ${res.dialogVersion ?? "?"}${mismatch ? ` ≠ 期望 ${expected}（继续等待站点更新）` : ""}`);

    // premier 就绪 → 下载（premier 永远优先）
    if (res.premierState === "ready" && !mismatch) {
      args._[1] = res.appId;
      return cmdDownload(args);
    }
    // 免费镜像兜底：仅当根本没有 premier 行可等，或触发生成已超过 30 分钟仍未就绪
    if (res.freeReady && !mismatch && res.premierState !== "requestable" && res.premierState !== "in_progress") {
      const last = state[res.appId]?.linkRequestedAt ? Date.parse(state[res.appId].linkRequestedAt) : 0;
      const freeFallbackOk = res.premierState == null || (last && Date.now() - last > 30 * 60_000);
      if (freeFallbackOk) {
        log("premier 长时间未就绪，使用免费镜像兜底下载");
        args._[1] = res.appId;
        args._skipPremierWait = true;
        return cmdDownload(args);
      }
    }
    if (res.premierState === "need_login" || res.premierState === "not_premier" || res.premierState === "error" || (res.premierState == null && !res.freeReady)) {
      return out({ ok: false, error: String(res.premierState ?? "NO_FILE").toUpperCase(), message: "watch 中止", detail: res });
    }
    await sleep(Math.min(interval, deadline - Date.now()));
  }
  out({ ok: false, error: "WATCH_TIMEOUT" });
}

// ---------- main ----------
const [, , cmd, ...rest] = process.argv;
const args = parseArgs(process.argv.slice(2));
const commands = { login: cmdLogin, whoami: cmdWhoami, request: cmdRequest, status: cmdStatus, download: cmdDownload, watch: cmdWatch };
if (!cmd || !commands[cmd]) {
  console.error(`decryptday CLI — decrypt.day 全自动工具

用法 (已在 /opt/homebrew/bin/decryptday 装好全局命令):
  decryptday login                 首次登录（弹出浏览器，Discord 授权一次，会话持久化）
  decryptday whoami                检查登录/Premier 状态
  decryptday request <链接|id>     提交解密请求
  decryptday status                查看我的请求状态 (new/in progress/done/rejected)
  decryptday download <id|链接>    下载 IPA [--out 目录] [--version x.y.z] [--force] [--wait 秒]
  decryptday watch <id|链接>       轮询等解密完成后自动下载 [--interval 秒] [--timeout 秒]

说明: 请求 DONE 后 premier 链接需触发生成——download/watch 会自动点击 "Request link"
      并等待生成完成；版本自动校验（与 request 时登记的版本比对，--version 可覆盖，--force 跳过）

通用: --json 输出 JSON
注意: 工具会弹出真实 Chrome 窗口（Cloudflare 要求），操作完成后自动关闭`);
  process.exit(cmd ? 1 : 0);
}
commands[cmd](args).catch((e) => {
  out({ ok: false, error: "CRASH", message: String(e?.stack || e) });
  process.exit(1);
});
