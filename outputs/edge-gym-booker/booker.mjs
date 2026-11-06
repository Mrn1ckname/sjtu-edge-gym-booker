import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createDiagnostics } from "./diagnostics.mjs";
import { gridTracker, GridNotReadyError } from "./grid-sync.mjs";
import { cleanOldLogs } from "./log-retention.mjs";
let diagnostics = null;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "config.json");
const EXAMPLE_CONFIG_PATH = path.join(ROOT, "config.example.json");
const PROFILE_PATH = path.join(ROOT, ".edge-profile");
const AUTH_STATE_PATH = path.join(ROOT, ".auth-state.json");
const LOG_DIR = path.join(ROOT, "logs");
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

class RetryableBookingError extends Error {}
class ScheduledWindowClosedError extends Error {}
class AuthenticationExpiredError extends Error {}

const authenticationGuards = new WeakMap();
const authenticationRecoveryFailures = new WeakMap();
const AUTH_BOOTSTRAP_MARKER = "__sjtu_auth_bootstrapped__";

function installAuthenticationGuard(context) {
  if (authenticationGuards.has(context)) return authenticationGuards.get(context);
  let generation = 0;
  let failure = null;
  let venueVerified = false;
  const requests = new Set();
  const inspections = new Set();
  const requestGenerations = new WeakMap();

  function isVenueApi(request) {
    return new URL(request.url()).hostname === "sports.sjtu.edu.cn" &&
      ["xhr", "fetch"].includes(request.resourceType());
  }
  function blocksAuthentication(request) {
    return /\/(?:system\/user\/currentUser|manage\/venue\/queryVenueById)$/.test(new URL(request.url()).pathname);
  }

  context.on("request", (request) => {
    if (!isVenueApi(request)) return;
    requestGenerations.set(request, generation);
    if (blocksAuthentication(request)) requests.add(request);
  });
  const finishRequest = (request) => requests.delete(request);
  context.on("requestfinished", finishRequest);
  context.on("requestfailed", finishRequest);
  context.on("response", (response) => {
    const request = response.request();
    if (!isVenueApi(request)) return;
    const responseGeneration = requestGenerations.get(request) ?? generation;
    if (responseGeneration !== generation) return;
    const apiPath = new URL(response.url()).pathname;
    const recordFailure = (code) => {
      if (responseGeneration !== generation || failure) return;
      failure = new AuthenticationExpiredError(
        `登录已失效：${apiPath} 返回${code}。已停止本次预约，不会自动重试或提交订单；请先运行 npm run login 重新登录。`
      );
    };
    if (response.status() === 401) recordFailure(" HTTP 401");
    const inspection = response.json().then((body) => {
      if (String(body?.code) === "401") recordFailure("业务码 401");
      if (responseGeneration === generation && apiPath === '/manage/venue/queryVenueById' &&
          response.ok() && ['0', '200'].includes(String(body?.code)) && body?.data?.venueId) venueVerified = true;
    }).catch(() => {});
    if (blocksAuthentication(request)) inspections.add(inspection);
    void inspection.then(() => inspections.delete(inspection));
  });

  const guard = {
    beforeNavigation() {
      // 已知的认证失败仍需恢复；旧页面未完成的请求不能阻止刷新。
      if (failure) throw failure;
      guard.reset();
    },
    reset() {
      generation += 1;
      failure = null;
      venueVerified = false;
      requests.clear();
      inspections.clear();
    },
    async requireVenue() {
      await guard.check();
      if (!venueVerified) throw new RetryableBookingError('尚未收到本次登录后的有效场馆响应');
    },
    async check() {
      const deadline = Date.now() + 5_000;
      while (requests.size > 0 || inspections.size > 0) {
        if (failure) throw failure;
        if (Date.now() >= deadline) {
          throw new RetryableBookingError("认证检查尚未完成，场馆接口仍在响应中");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (failure) throw failure;
    }
  };
  authenticationGuards.set(context, guard);
  return guard;
}

async function assertAuthenticated(page) {
  await authenticationGuards.get(page.context())?.check();
}

function scheduledSkipReason(config, now = new Date()) {
  if (new Date(now.getTime() + 8 * 3600000).getUTCDay() === 3) return "周三不执行定时预约";
  if (config.targetDateMode !== "auto" || config.releaseAt !== "auto") {
    return "定时运行要求 targetDate 和 releaseAt 均为 auto";
  }
  const release = new Date(resolveReleaseAt(config)).getTime();
  if (now.getTime() < release - 15_000) return "尚未到 11:59:45 的定时启动窗口";
  if (now.getTime() >= release + 3 * 60_000) return "已超过 12:03 的预约截止时间，跳过本次预约";
  return null;
}

function enforceScheduledWindow(config, scheduled) {
  if (!scheduled) return;
  const reason = scheduledSkipReason(config);
  if (reason) throw new ScheduledWindowClosedError(reason);
}

function isRetryableBeforeSubmission(error) {
  if (error instanceof AuthenticationExpiredError) return false;
  return error instanceof RetryableBookingError ||
    error instanceof GridNotReadyError ||
    error.name === "TimeoutError" ||
    /net::ERR_(?:ABORTED|CONNECTION|INTERNET|NETWORK|NAME_NOT_RESOLVED|TIMED_OUT)/.test(error.message);
}

function isAfterChinaNoon(now = new Date()) {
  const chinaHour = new Date(now.getTime() + 8 * 60 * 60 * 1000).getUTCHours();
  return chinaHour >= 12;
}

function retryDelayMs(config, now = new Date(), error = null, failures = 0) {
  if (!isAfterChinaNoon(now)) return config.retryIntervalMs;
  if (/429|频繁|限流/.test(error?.message || '')) return 5000;
  if (error && isLoadingFailure(error)) return Math.min(3000, 500 * 2 ** Math.min(failures, 3));
  return 300;
}

function isLoadingFailure(error) {
  return isRetryableBeforeSubmission(error) &&
    !/暂无可选场地|没有找到同时满足|等待下一轮更新日期列表|网站返回：/.test(error.message);
}

function log(message) {
  console.log(`[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function applyWeekdayBooking(config, now = new Date()) {
  const weekday = new Date(now.getTime() + 8 * 60 * 60 * 1000).getUTCDay();
  if (weekday === 4 && config.thursdayBooking) return { ...config, ...config.thursdayBooking };
  // 沿用已有 sundayBooking 字段，周六与周日共享羽毛球配置。
  return [0, 6].includes(weekday) && config.sundayBooking ? { ...config, ...config.sundayBooking } : config;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(`找不到 config.json。请先复制 ${path.basename(EXAMPLE_CONFIG_PATH)} 为 config.json 并填写预约信息。`);
  }
  const config = applyWeekdayBooking(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  validateConfig(config);
  return {
    ...config,
    targetDateMode: config.targetDate,
    targetDate: resolveTargetDate(config.targetDate)
  };
}

function validateConfig(config) {
  if (!/^https:\/\/sports\.sjtu\.edu\.cn\//.test(config.bookingUrl || "")) {
    fail("bookingUrl 必须是 sports.sjtu.edu.cn 的预约详情页。 ");
  }
  if (config.targetDate !== "auto" && !/^\d{4}-\d{2}-\d{2}$/.test(config.targetDate || "")) {
    fail("targetDate 必须是 auto 或 YYYY-MM-DD 格式。 ");
  }
  if (!Array.isArray(config.timeSlots) || config.timeSlots.length === 0) {
    fail("timeSlots 至少需要一个时段。 ");
  }
  for (const slot of config.timeSlots) {
    parseTimeSlot(slot);
  }
  if (!Array.isArray(config.preferredCourts)) {
    fail("preferredCourts 必须是数组。 ");
  }
  if (!Array.isArray(config.excludedCourts ?? [])) {
    fail("excludedCourts 必须是数组。 ");
  }
  if (
    config.releaseAt !== "auto" &&
    config.releaseAt !== null &&
    config.releaseAt !== "" &&
    Number.isNaN(new Date(config.releaseAt).getTime())
  ) {
    fail("releaseAt 必须是 auto、null，或带时区的 ISO 时间，例如 2026-10-21T12:00:00+08:00。 ");
  }
  if ((config.retryIntervalMs ?? 1500) < 1000) {
    fail("retryIntervalMs 不能小于 1000，以免给场馆网站造成过高请求压力。 ");
  }
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 120) {
    fail("maxAttempts 必须是 1 到 120 之间的整数。 ");
  }
  if (typeof config.dryRun !== "boolean") {
    fail("dryRun 必须是 true 或 false。 ");
  }
  if (!Number.isInteger(config.paymentTimeoutMs) || config.paymentTimeoutMs < 15_000 || config.paymentTimeoutMs > 300_000) {
    fail("paymentTimeoutMs 必须是 15000 到 300000 之间的整数。 ");
  }
}

function resolveTargetDate(value, now = new Date()) {
  if (value !== "auto") return value;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(now)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: partValue }) => [type, partValue])
  );
  const target = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 7, 12));
  return [target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate()]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join("-");
}

function parseTimeSlot(slot) {
  const match = /^(\d{2}):00-(\d{2}):00$/.exec(slot);
  if (!match) fail(`时段 ${slot} 无效；本站只支持整点格式，例如 18:00-19:00。`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 7 || end > 22 || end !== start + 1) {
    fail(`时段 ${slot} 超出本站 07:00-22:00 的单小时网格。`);
  }
  return { slot, rowIndex: start - 7 };
}

function edgeExecutable() {
  const found = EDGE_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!found) fail("未找到 Microsoft Edge。请确认 Edge 已安装。 ");
  return found;
}

async function launchEdge({ restoreAuth = true } = {}) {
  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    executablePath: edgeExecutable(),
    headless: false,
    viewport: null,
    locale: "zh-CN",
    args: ["--start-maximized"]
  });
  installAuthenticationGuard(context);
  if (restoreAuth && fs.existsSync(AUTH_STATE_PATH)) {
    const state = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, "utf8"));
    await restoreAuthentication(context, state);
    log("已载入保存的认证信息，优先保留浏览器中的较新状态；有效性将由场馆接口验证。");
  }
  return context;
}

async function restoreAuthentication(context, state) {
  const existingCookies = new Set((await context.cookies()).map(({ name, domain, path: cookiePath }) =>
    JSON.stringify([name, domain, cookiePath])));
  const missingCookies = (state.cookies || []).filter(({ name, domain, path: cookiePath, expires }) =>
    !existingCookies.has(JSON.stringify([name, domain, cookiePath])) &&
    (expires <= 0 || expires > Date.now() / 1000));
  if (missingCookies.length > 0) await context.addCookies(missingCookies);
  await context.addInitScript(({ savedState, marker }) => {
    if (sessionStorage.getItem(marker)) return;
    sessionStorage.setItem(marker, "1");
    const local = (savedState.origins || []).find((entry) => entry.origin === location.origin);
    for (const item of local?.localStorage || []) {
      if (localStorage.getItem(item.name) === null) localStorage.setItem(item.name, item.value);
    }
    const session = (savedState.sessionOrigins || []).find((entry) => entry.origin === location.origin);
    for (const item of session?.sessionStorage || []) {
      if (item.name !== marker && sessionStorage.getItem(item.name) === null) {
        sessionStorage.setItem(item.name, item.value);
      }
    }
  }, { savedState: state, marker: AUTH_BOOTSTRAP_MARKER });
}

async function saveAuthentication(context, verifiedPage) {
  await assertAuthenticated(verifiedPage);
  const state = await context.storageState();
  state.sessionOrigins = [];
  state.savedAt = new Date().toISOString();
  const seenOrigins = new Set();
  // 当前已验证页面优先，避免另一个旧标签页覆盖新令牌。
  for (const authPage of [verifiedPage, ...context.pages().filter(page => page !== verifiedPage)]) {
    try {
      const origin = new URL(authPage.url()).origin;
      if (!origin.startsWith("http") || seenOrigins.has(origin)) continue;
      const sessionStorage = await authPage.evaluate((marker) =>
        Object.entries(window.sessionStorage)
          .filter(([name]) => name !== marker)
          .map(([name, value]) => ({ name, value })), AUTH_BOOTSTRAP_MARKER);
      state.sessionOrigins.push({ origin, sessionStorage });
      seenOrigins.add(origin);
    } catch {
      // 跳转中的其他页面不影响已验证页面的保存。
    }
  }
  // 保存期间若又出现 401，保留上一份已验证认证信息。
  await assertAuthenticated(verifiedPage);
  fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(state, null, 2));
}

async function clickCampusLogin(page) {
  // 页面顶部和登录弹窗有同名按钮；优先使用后出现的可见弹窗按钮。
  const campusLogin = page.getByRole("button", { name: "校内人员登录", exact: true }).filter({ visible: true }).last();
  await campusLogin.waitFor({ state: "visible", timeout: 10_000 });
  await campusLogin.click({ timeout: 10_000, noWaitAfter: true });
  const dialogLogin = page.locator("#loginSelection:visible")
    .getByRole("button", { name: "校内人员登录", exact: true });
  try {
    // 若刚才点的是顶部入口，它会先打开登录方式弹窗。
    await dialogLogin.waitFor({ state: "visible", timeout: 1_000 });
  } catch (error) {
    if (error.name === "TimeoutError") return;
    throw error;
  }
  await dialogLogin.click({ timeout: 10_000, noWaitAfter: true });
}

async function recoverAuthentication(page, config, { saveState = saveAuthentication } = {}) {
  const context = page.context();
  log("认证已失效，尝试通过现有交我办登录状态自动恢复……");
  diagnostics?.record('auth-recovery-start', {});
  try {
    let needsCampusLogin = await page.getByRole("button", { name: "校内人员登录", exact: true })
      .filter({ visible: true }).count() > 0;
    if (!needsCampusLogin) {
      if (new URL(page.url()).origin === "https://sports.sjtu.edu.cn") {
        await page.evaluate(() => {
          sessionStorage.removeItem("token");
          sessionStorage.removeItem("isname");
        });
      }
      authenticationGuards.get(context)?.reset();
      await reloadBookingDocument(page, config, 'auth-recovery');
      try {
        await ensureLoggedIn(page);
      } catch (error) {
        if (!(error instanceof AuthenticationExpiredError)) throw error;
        needsCampusLogin = true;
        if (await page.getByRole("button", { name: "校内人员登录", exact: true }).filter({ visible: true }).count() === 0) {
          // 仅在没有登录入口且场馆认证被拒绝时重建场馆会话。
          await context.clearCookies({ name: "JSESSIONID", domain: "sports.sjtu.edu.cn" });
          authenticationGuards.get(context)?.reset();
          await reloadBookingDocument(page, config, 'auth-session-reset');
        }
      }
    }
    if (needsCampusLogin) {
      authenticationGuards.get(context)?.reset();
      diagnostics?.record('campus-login-click', {});
      await clickCampusLogin(page);
      await page.waitForFunction(() =>
        !!document.querySelector('input[type="password"]') ||
        /请输入密码|请输入验证码|请完成安全验证/.test(document.body?.innerText || "") ||
        (location.origin === "https://sports.sjtu.edu.cn" &&
        document.body?.innerText.includes("我的订单") &&
        !document.body?.innerText.includes("校内人员登录")), null, { timeout: 15_000 });
      if (await requiresHumanLogin(page)) throw new AuthenticationExpiredError("登录页面要求密码或人工验证");
      await waitForLoginReturn(page);
      authenticationGuards.get(context)?.beforeNavigation();
      await reloadBookingDocument(page, config, 'after-campus-login');
    }
    await ensureLoggedIn(page);
    // 不能仅凭“我的订单”空壳认定成功；场地网格也必须真实加载。
    await waitForGrid(page);
    await assertAuthenticated(page);
    await authenticationGuards.get(context)?.requireVenue();
    await saveState(context, page);
    authenticationRecoveryFailures.delete(context);
    log("登录已自动恢复；新的认证信息已验证并保存。");
    diagnostics?.record('auth-recovery-complete', {});
  } catch (error) {
    diagnostics?.record('auth-recovery-error', { message: error.message });
    const failures = (authenticationRecoveryFailures.get(context) || 0) + 1;
    authenticationRecoveryFailures.set(context, failures);
    if (!(await requiresHumanLogin(page)) &&
        (isRetryableBeforeSubmission(error) || error instanceof AuthenticationExpiredError)) {
      throw new RetryableBookingError(`登录恢复尚未完成（连续失败 ${failures} 次），将刷新后继续尝试：${error.message}`);
    }
    throw new AuthenticationExpiredError(
      `无法自动恢复登录：需要人工验证或已连续失败 ${failures} 次。请运行 npm run login 完成登录。原因：${error.message}`
    );
  }
}

async function requiresHumanLogin(page) {
  return await page.locator('input[type="password"]:visible').count() > 0 ||
    /请输入密码|请输入验证码|请完成安全验证|向右滑动完成验证|拖动滑块/.test(await pageText(page));
}

async function reloadBookingDocument(page, config, reason) {
  diagnostics?.record('document-reload-start', { reason });
  // hash 路由的 goto 可能不创建新文档；同站点必须明确 reload。
  const current = new URL(page.url());
  const target = new URL(config.bookingUrl);
  if (current.origin === target.origin && current.pathname === target.pathname) {
    await page.evaluate(url => history.replaceState(null, '', url), config.bookingUrl);
    authenticationGuards.get(page.context())?.reset();
    await page.reload({ waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(config.bookingUrl, { waitUntil: 'domcontentloaded' });
  }
  diagnostics?.record('document-reload-complete', { reason });
}

async function waitForLoginReturn(page) {
  if (!/^https:\/\/sports\.sjtu\.edu\.cn(?:\/|$)/.test(page.url()) && page.url() !== 'about:blank') {
    if (await requiresHumanLogin(page)) throw new AuthenticationExpiredError('登录页面要求人工验证');
    diagnostics?.record('auth-redirect-wait', {});
    await page.waitForURL(url => url.origin === 'https://sports.sjtu.edu.cn', { timeout: 15000, waitUntil: 'domcontentloaded' });
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
}

async function openAuthenticatedBookingPage(page, config, options) {
  gridTracker(page, (event, data) => diagnostics?.record(event, data));
  try {
    await waitForLoginReturn(page);
    authenticationGuards.get(page.context())?.beforeNavigation();
    if (page.url() === config.bookingUrl) {
      await page.reload({ waitUntil: "domcontentloaded" });
    } else {
      await page.goto(config.bookingUrl, { waitUntil: "domcontentloaded" });
    }
    await ensureLoggedIn(page);
  } catch (error) {
    if (!(error instanceof AuthenticationExpiredError)) throw error;
    await recoverAuthentication(page, config, options);
  }
}

async function getPage(context) {
  const pages = context.pages();
  return pages[0] || context.newPage();
}

async function loginMode() {
  const example = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, "utf8"));
  const config = fs.existsSync(CONFIG_PATH) ? readConfig() : example;
  const context = await launchEdge({ restoreAuth: false });
  const page = await getPage(context);
  await page.goto(config.bookingUrl, { waitUntil: "domcontentloaded" });
  const campusLogin = page.getByRole("button", { name: "校内人员登录", exact: true });
  if ((await campusLogin.count()) > 0 && await campusLogin.first().isVisible()) {
    await clickCampusLogin(page);
  }
  log("已打开脚本专用 Edge。请只在这个窗口中完成交我办登录；脚本会自动检测，不需要回终端按键。 ");
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes("我的订单") && !document.body.innerText.includes("校内人员登录"),
      null,
      { timeout: 10 * 60_000 }
    );
    // 重新登录后，舍弃登录前的 401；只验证这次重新加载发出的请求。
    authenticationGuards.get(context).reset();
    await page.goto(config.bookingUrl, { waitUntil: "domcontentloaded" });
    await ensureLoggedIn(page);
    await waitForGrid(page);
    await assertAuthenticated(page);
    log("已验证登录成功，并确认预约网格可以读取。 ");
    await saveAuthentication(context, page);
    await context.close();
    log("登录状态已显式保存到脚本专用认证文件。 ");
  } catch (error) {
    await capture(page, "login-error");
    await context.close().catch(() => {});
    fail(`未能在 10 分钟内验证登录状态：${error.message}`);
  }
}

async function waitUntilRelease(releaseAt) {
  if (!releaseAt) return;
  const target = new Date(releaseAt).getTime();
  if (target <= Date.now()) return;
  log(`等待开抢时间：${new Date(target).toLocaleString("zh-CN", { hour12: false })}`);
  while (Date.now() < target) {
    const remaining = target - Date.now();
    if (remaining > 60_000) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, remaining - 30_000)));
    } else if (remaining > 2_000) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, remaining - 1_000)));
    } else {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, remaining)));
    }
  }
}

function resolveReleaseAt(config) {
  if (config.releaseAt !== "auto") return config.releaseAt;
  const targetNoonChina = new Date(`${config.targetDate}T12:00:00+08:00`);
  if (Number.isNaN(targetNoonChina.getTime())) fail("无法根据 targetDate 计算开抢时间。 ");
  return new Date(targetNoonChina.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function ensureLoggedIn(page) {
  await assertAuthenticated(page);
  try {
    await page.waitForFunction(() => {
      const text = document.body?.innerText || "";
      return /校内人员登录|统一身份认证|登录已过期|登录失效|请重新登录/.test(text) ||
        (text.includes("我的订单") && document.querySelector(".lists"));
    }, null, { timeout: 15_000 });
  } catch {
    await assertAuthenticated(page);
    throw new RetryableBookingError("页面未显示有效的登录状态或预约区域，可能仍在加载");
  }
  await assertAuthenticated(page);
  if (/校内人员登录|统一身份认证|登录已过期|登录失效|请重新登录/.test(await pageText(page))) {
    throw new AuthenticationExpiredError("登录已失效，请先运行 npm run login。已停止本次预约。 ");
  }
}

async function clickActivityType(page, activityType) {
  if (!activityType) return;
  const roleTab = page.getByRole("tab", { name: activityType, exact: true });
  const escapedType = activityType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fallback = page.locator(".lists .el-tabs__item")
    .filter({ hasText: new RegExp(`^\\s*${escapedType}\\s*$`) });
  const target = roleTab.or(fallback).first();
  try {
    await target.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    await ensureLoggedIn(page);
    const unavailable = (await pageText(page)).includes("暂不开放");
    throw new RetryableBookingError(
      `场馆数据未就绪，尚未找到“${activityType}”分类${unavailable ? "（页面显示暂不开放）" : ""}`
    );
  }
  await target.click();
  await waitForGrid(page);
}

async function clickDate(page, targetDate) {
  const tracker = gridTracker(page, (event, data) => diagnostics?.record(event, data));
  const dateTab = page.locator(`[id="tab-${targetDate}"]`);
  try {
    await dateTab.first().waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    const [, month, day] = targetDate.split("-");
    const label = `${Number(month)}月${Number(day)}日`;
    const fallback = page.getByRole("tab", { name: new RegExp(`^${label}`) });
    if ((await fallback.count()) === 0) {
      throw new RetryableBookingError(`日期 ${targetDate} 尚未出现在可预约日期中`);
    }
    await fallback.first().click();
    await tracker.idle();
    await waitForGrid(page);
    await assertBookingDate(page, targetDate);
    return;
  }
  await dateTab.first().click();
  await tracker.idle();
  await waitForGrid(page);
  await assertBookingDate(page, targetDate);
}

async function assertBookingDate(page, targetDate) {
  const correct = await page.evaluate(date => {
    const active = [...document.querySelectorAll('[role="tab"][aria-selected="true"], .el-tabs__item.is-active')];
    const [, month, day] = date.split('-');
    const label = new RegExp(`^0?${Number(month)}月0?${Number(day)}日`);
    return active.some(el => el.id === `tab-${date}` || label.test(el.innerText.trim())) &&
      (document.body?.innerText || '').includes(date);
  }, targetDate);
  if (!correct) throw new RetryableBookingError(`日期核验失败：活动日期和预约摘要必须同时为 ${targetDate}，将重新加载选场`);
}

async function waitForGrid(page) {
  const loading = page.locator(".tables .el-loading-mask");
  if ((await loading.count()) > 0) {
    await loading.first().waitFor({ state: "hidden", timeout: 30_000 });
  }
  await page.locator(".inner-seat-wrapper").waitFor({ state: "visible", timeout: 12_000 });
  await page.waitForFunction(() =>
    document.querySelector(".topsiteStyle") && document.querySelector(".seat"),
    null, { timeout: 12_000 });
}

async function readGrid(page) {
  const wrapper = page.locator(".inner-seat-wrapper");
  let headers = wrapper.locator(".topsiteStyle");
  let seats = wrapper.locator(".seat");
  if ((await headers.count()) === 0) headers = page.locator(".topsiteStyle");
  if ((await seats.count()) === 0) seats = page.locator(".seat");
  const courtNames = [];
  for (let index = 0; index < await headers.count(); index += 1) {
    const header = headers.nth(index);
    courtNames.push(((await header.getAttribute("title")) || (await header.innerText())).trim());
  }
  const seatCount = await seats.count();
  if (courtNames.length === 0 || seatCount === 0 || seatCount % courtNames.length !== 0) {
    throw new RetryableBookingError("场地网格结构尚未稳定");
  }
  return { seats, courtNames, courtCount: courtNames.length };
}

function courtOrder(courtNames, preferredCourts, excludedCourts = []) {
  const excluded = excludedCourts.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const unused = new Set(
    courtNames
      .map((name, index) => ({ name: name.toLowerCase(), index }))
      .filter(({ name }) => !excluded.some((needle) => name.includes(needle)))
      .map(({ index }) => index)
  );
  const order = [];
  for (const preferred of preferredCourts) {
    const needle = preferred.trim().toLowerCase();
    if (!needle) continue;
    for (let index = 0; index < courtNames.length; index += 1) {
      if (unused.has(index) && courtNames[index].toLowerCase().includes(needle)) {
        order.push(index);
        unused.delete(index);
      }
    }
  }
  order.push(...unused);
  return order;
}

function seatIndex(courtCount, rowIndex, courtIndex) {
  return rowIndex * courtCount + courtIndex;
}

function seatAt(seats, courtCount, rowIndex, courtIndex) {
  return seats.nth(seatIndex(courtCount, rowIndex, courtIndex));
}

async function isAvailable(seats, courtCount, rowIndex, courtIndex) {
  const cell = seatAt(seats, courtCount, rowIndex, courtIndex);
  return (await cell.locator(".inner-seat.unselected-seat").count()) > 0;
}

async function chooseSlots(page, config) {
  const slots = config.timeSlots.map(parseTimeSlot);
  const { seats, courtNames, courtCount } = await readGrid(page);
  if (courtNames.length === 0) throw new RetryableBookingError("场地网格尚未加载");
  const orderedCourts = courtOrder(courtNames, config.preferredCourts, config.excludedCourts ?? []);
  if (orderedCourts.length === 0) {
    fail("排除规则过滤掉了全部场地，请检查 excludedCourts。 ");
  }
  const picks = [];

  if (config.sameCourt) {
    for (const courtIndex of orderedCourts) {
      let allAvailable = true;
      for (const { rowIndex } of slots) {
        if (!(await isAvailable(seats, courtCount, rowIndex, courtIndex))) {
          allAvailable = false;
          break;
        }
      }
      if (allAvailable) {
        for (const slot of slots) picks.push({ ...slot, courtIndex, courtName: courtNames[courtIndex] });
        break;
      }
    }
  } else {
    for (const slot of slots) {
      let chosen = -1;
      for (const candidate of orderedCourts) {
        if (await isAvailable(seats, courtCount, slot.rowIndex, candidate)) {
          chosen = candidate;
          break;
        }
      }
      if (chosen < 0) throw new RetryableBookingError(`时段 ${slot.slot} 暂无可选场地`);
      picks.push({ ...slot, courtIndex: chosen, courtName: courtNames[chosen] });
    }
  }

  if (picks.length !== slots.length) {
    throw new RetryableBookingError(`没有找到同时满足 ${config.timeSlots.join("、")} 的场地`);
  }

  for (const pick of picks) {
    const cell = seatAt(seats, courtCount, pick.rowIndex, pick.courtIndex);
    await cell.click();
    await cell.locator(".inner-seat.selected-seat").waitFor({ state: "visible", timeout: 3_000 });
    log(`已选择：${pick.courtName} ${pick.slot}`);
  }
  for (const pick of picks) {
    const cell = seatAt(seats, courtCount, pick.rowIndex, pick.courtIndex);
    if ((await cell.locator(".inner-seat.selected-seat").count()) === 0) {
      fail("网站规则不允许同时选择配置中的全部时段；请减少 timeSlots 后重试。 ");
    }
  }
  return picks;
}

async function attemptBooking(page, config) {
  const tracker = gridTracker(page, (event, data) => diagnostics?.record(event, data));
  // 正常重试保留当前文档和登录态，只切日期触发网站自己的查询。
  if (page.url() !== config.bookingUrl) {
    await openAuthenticatedBookingPage(page, config);
  } else {
    try { await ensureLoggedIn(page); }
    catch (error) {
      if (!(error instanceof AuthenticationExpiredError)) throw error;
      await recoverAuthentication(page, config);
    }
  }
  await dismissBookingNotice(page);
  await tracker.idle();
  if (!(await page.locator('.lists .el-tabs__item').count())) {
    diagnostics?.record('empty-venue-recovery', {});
    await recoverAuthentication(page, config);
    await tracker.idle();
  }
  const activeActivity = await page.locator('.el-tabs__item.is-active, [role="tab"][aria-selected="true"]')
    .allTextContents();
  if (!activeActivity.some(text => text.trim() === config.activityType)) {
    await clickActivityType(page, config.activityType);
    // 项目切换会异步重置日期；必须等日期列表和默认网格均完成。
    await tracker.idle();
  }
  const target = page.locator(`[id="tab-${config.targetDate}"]`).first();
  if (!(await target.count())) {
    // 午间新日期尚未进入列表时，重新点击项目以更新列表，无需整页刷新。
    await clickActivityType(page, config.activityType);
    await tracker.idle();
    // 日期列表请求已完成仍没有目标日期时，等待不存在的按钮不会产生新数据。
    if (!(await target.count())) {
      diagnostics?.record('date-not-released', { targetDate: config.targetDate });
      throw new GridNotReadyError(`日期 ${config.targetDate} 尚未开放，等待下一轮更新日期列表`);
    }
  }
  // 网站的 tab-click 即使点击当前日期也会重新查询，省去查询其他日期的往返。
  const before = tracker.sequence;
  diagnostics?.record('date-refresh', { targetDate: config.targetDate, mode: 'target-date-click', afterRequestId: before });
  await clickDate(page, config.targetDate);
  await assertAuthenticated(page);
  await tracker.ready(config, before);
  await assertBookingDate(page, config.targetDate);
  return chooseSlots(page, config);
}

async function pageText(page) {
  return page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
}

async function visiblePaymentAction(page) {
  const action = page.getByText(/^(立即支付|去支付|在线支付)$/, { exact: true }).first();
  if ((await action.count()) === 0) return null;
  return (await action.isVisible().catch(() => false)) ? action : null;
}

function hasPaymentInterface(url, bodyText) {
  const normalized = bodyText.replace(/\s+/g, " ");
  const paymentUrl = /(?:^|[\/#?_-])(pay|payment|cashier|checkout)(?:[\/#?_-]|$)/i.test(url);
  const paymentUi = /(收银台|选择支付方式|扫码支付|付款二维码|微信支付|支付宝支付|支付剩余时间|请使用.*扫码)/.test(normalized);
  return paymentUrl || paymentUi;
}

function hasCaptcha(bodyText) {
  return /(请完成安全验证|向右滑动完成验证|拖动滑块完成拼图)/.test(bodyText);
}

async function dismissBookingNotice(page) {
  const notice = page.locator('.el-dialog:visible').filter({ hasText: '本人已认真阅读' });
  if (!(await notice.count())) return;
  await notice.getByRole('button', { name: '上一步', exact: true }).click({ timeout: 3000 });
  await notice.waitFor({ state: 'hidden', timeout: 3000 });
  diagnostics?.record('booking-notice-dismissed', { reason: 'before-retry' });
}

// 仅关联监听器安装后由本页面发出的下单请求，不接收上一轮迟到的响应。
function observeOrderSubmission(page) {
  const requests = new Set();
  let result = null, closed = false;
  const onRequest = request => {
    const url = new URL(request.url());
    if (url.origin === 'https://sports.sjtu.edu.cn' && url.pathname === '/venue/personal/ConfirmOrder' && request.method() === 'POST') requests.add(request);
  };
  const onResponse = async response => {
    if (!requests.has(response.request())) return;
    try {
      const body = await response.json();
      if (closed) return;
      const code = body?.code;
      const message = String(body?.msg ?? body?.message ?? '').slice(0, 500);
      if (!response.ok() || (code != null && String(code) !== '0')) {
        result = { outcome: 'submit-error', page, message: message || `下单接口返回 HTTP ${response.status()}，业务码 ${code}` };
      } else if (String(code) === '0') {
        result = { outcome: 'order-confirmed', page };
      }
      diagnostics?.record('order-api-result', { httpStatus: response.status(), code, message, outcome: result?.outcome ?? 'submission-unknown' });
    } catch (error) {
      if (!closed) diagnostics?.record('order-api-unreadable', { message: error.message });
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return { get result() { return result; }, close() {
    closed = true;
    page.off('request', onRequest);
    page.off('response', onResponse);
  } };
}

async function waitForPaymentInterface(context, originalPage, timeoutMs, submission) {
  const deadline = Date.now() + timeoutMs;
  let payActionClicked = false;
  let orderPage = originalPage;

  while (Date.now() < deadline) {
    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      const url = candidate.url();
      const body = await pageText(candidate);

      if (hasCaptcha(body)) return { outcome: "captcha", page: candidate };

      if (hasPaymentInterface(url, body)) {
        await candidate.bringToFront().catch(() => {});
        return { outcome: "payment-ready", page: candidate };
      }

      if (submission?.result?.outcome === 'submit-error') return submission.result;

      const paymentAction = await visiblePaymentAction(candidate);
      if (paymentAction && !payActionClicked) {
        payActionClicked = true;
        orderPage = candidate;
        log("订单已创建；正在进入支付界面（不会进行实际支付）……");
        await paymentAction.click({ timeout: 10_000, noWaitAfter: true });
        break;
      }


      if (url.includes("/orderDetails/") || /(订单详情|待支付)/.test(body)) {
        orderPage = candidate;
      }

      const knownError = ["您有尚未支付的订单", "预约失败", "场地已满", "场地预定人数已满", "已被预定", "场地信息已过期", "下单失败"].find((text) => body.includes(text));
      if (knownError) return { outcome: "submit-error", page: candidate, message: knownError };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    outcome: payActionClicked || submission?.result?.outcome === 'order-confirmed' ? "payment-timeout" : "submission-unknown",
    page: orderPage
  };
}

async function submitOrder(context, page, config, picks, scheduled = false) {
  await assertAuthenticated(page);
  enforceScheduledWindow(config, scheduled);
  await assertBookingDate(page, config.targetDate);
  await diagnostics?.snapshot(page, "before-order", { captureImage: false });
  if (config.dryRun) {
    log("演练模式：已选中目标场地，但不会点击“立即下单”。把 config.json 的 dryRun 改为 false 才会真实提交。 ");
    return { outcome: "dry-run", page };
  }

  const summary = page.locator("body");
  for (const pick of picks) {
    const summaryText = `${pick.courtName} ${pick.slot}`;
    if (!(await summary.innerText()).replace(/\s+/g, " ").includes(summaryText)) {
      throw new RetryableBookingError(`提交前未在订单摘要中确认到“${summaryText}”，将重新选场。`);
    }
  }

  await page.getByRole("button", { name: /立即下单/ }).click();
  const dialog = page.locator(".el-dialog:visible").filter({ hasText: "本人已认真阅读" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const checkboxLabel = dialog.locator("label.el-checkbox");
  const checkbox = dialog.locator('input[type="checkbox"]');
  if (!(await checkbox.isChecked())) await checkboxLabel.click();
  if (!(await checkbox.isChecked())) throw new RetryableBookingError("预订须知未能成功勾选，将重试。 ");
  const submit = dialog.getByRole("button", { name: /提交订单/ });
  if (!(await submit.isEnabled())) throw new RetryableBookingError("“提交订单”按钮仍不可用，将重试。 ");

  log("即将提交订单；未确认成功时将按配置继续刷新重试。 ");
  await assertAuthenticated(page);
  enforceScheduledWindow(config, scheduled);
  await assertBookingDate(page, config.targetDate);
  await diagnostics?.snapshot(page, "before-submit", { captureImage: false });
  enforceScheduledWindow(config, scheduled);
  await assertBookingDate(page, config.targetDate);
  if (!(await checkbox.isChecked())) throw new RetryableBookingError('提交前须知勾选状态发生变化，将重试。');
  diagnostics?.record("submit-click", { targetDate: config.targetDate, activity: config.activityType, picks, sinceReleaseMs: Date.now() - new Date(resolveReleaseAt(config)).getTime() });
  const submission = observeOrderSubmission(page);
  let result;
  try {
    await submit.click({ timeout: 10_000, noWaitAfter: true });
    const remainingMs = scheduled ? new Date(resolveReleaseAt(config)).getTime() + 3 * 60_000 - Date.now() : config.paymentTimeoutMs;
    result = await waitForPaymentInterface(context, page, Math.max(0, Math.min(config.paymentTimeoutMs, remainingMs)), submission);
  } finally {
    submission.close();
  }
  diagnostics?.record("submit-result", { outcome: result.outcome, message: result.message });
  await diagnostics?.snapshot(result.page || page, "after-submit", { captureImage: result.outcome === "payment-ready" || result.outcome === "captcha" });

  if (result.outcome === "payment-ready") {
    log(`已到达支付界面并停止，未执行支付：${result.page.url()}`);
    return result;
  }
  if (result.outcome === "captcha") {
    log("网站要求滑块验证。已停止自动操作，请在 Edge 中手动完成验证。 ");
    return result;
  }
  if (result.outcome === "submit-error") {
    throw new RetryableBookingError(`网站返回：${result.message}，将重新加载并重试提交。`);
  }
  if (result.outcome === "submission-unknown") {
    throw new RetryableBookingError("尚未确认支付入口，将重新加载并重试提交。 ");
  }
  throw new RetryableBookingError("等待支付界面超时，将重新加载并重试。 ");
}

async function capture(page, label) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(LOG_DIR, `${stamp}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

async function holdOpen(context, minutes) {
  const ms = Math.max(1, Number(minutes) || 60) * 60_000;
  log(`Edge 将保持打开 ${Math.round(ms / 60_000)} 分钟；检查完成后也可直接关闭窗口或按 Ctrl+C。`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  await context.close();
}

async function bookingMode({ scheduled = false, configOverrides = {} } = {}) {
  const removedLogs = cleanOldLogs();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const runLog = path.join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-run.log`);
  diagnostics = createDiagnostics(runLog.replace(/\.log$/, '.jsonl'));
  diagnostics.record('log-cleanup', { retentionHours: 72, removed: removedLogs });
  for (const method of ["log", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      fs.appendFileSync(runLog, args.map(String).join(" ") + "\n");
      original(...args);
    };
  }
  const config = { ...readConfig(), ...configOverrides };
  validateConfig(config);
  diagnostics.setTarget(config);
  diagnostics.record('run-start', { scheduled, bookingUrl: config.bookingUrl, activity: config.activityType, targetDate: config.targetDate, timeSlots: config.timeSlots, dryRun: config.dryRun });
  const skipReason = scheduled ? scheduledSkipReason(config) : null;
  if (skipReason) {
    log(`跳过：${skipReason}。未启动 Edge。`);
    return;
  }
  let context = await launchEdge();
  diagnostics.attach(context);
  context.setDefaultNavigationTimeout(15_000);
  context.setDefaultTimeout(10_000);
  let page = await getPage(context);
  let closing = false;
  process.on("SIGINT", async () => {
    if (closing) return;
    closing = true;
    await context.close().catch(() => {});
    process.exit(130);
  });

  try {
    if (config.targetDateMode === "auto") {
      log(`自动目标日期：${config.targetDate}（中国日期的 7 天后）`);
    }
    try {
      await openAuthenticatedBookingPage(page, config);
      await waitForGrid(page);
      if (config.activityType) {
        const tracker = gridTracker(page, (event, data) => diagnostics?.record(event, data));
        await tracker.idle();
        const active = await page.locator('.el-tabs__item.is-active').allTextContents();
        if (!active.some(text => text.trim() === config.activityType)) {
          await clickActivityType(page, config.activityType);
          await tracker.idle();
        }
        diagnostics?.record('preload-ready', { activity: config.activityType });
      }
      await saveAuthentication(context, page);
    } catch (error) {
      if (!isRetryableBeforeSubmission(error)) throw error;
      log(`预加载未完成：${error.message}。开抢后会重新加载。`);
    }
    const releaseAt = resolveReleaseAt(config);
    if (config.releaseAt === "auto") {
      log(`自动计算开抢时间：${new Date(releaseAt).toLocaleString("zh-CN", { hour12: false })}（目标日期前 7 天中午 12:00）`);
    }
    if (scheduled && Date.now() < new Date(releaseAt).getTime() - 30_000) {
      await waitUntilRelease(new Date(new Date(releaseAt).getTime() - 30_000).toISOString());
      log('开抢前再次验证登录和预加载项目……');
      try {
        await openAuthenticatedBookingPage(page, config);
        await clickActivityType(page, config.activityType);
        await gridTracker(page).idle();
        await saveAuthentication(context, page);
      } catch (error) {
        if (!isRetryableBeforeSubmission(error)) throw error;
        log(`开抢前预检暂未完成：${error.message}`);
      }
    }
    await waitUntilRelease(releaseAt);

    let picks = null;
    let result = null;
    let consecutiveLoadingFailures = 0;
    let browserRestarts = 0;
    for (let attempt = 1; scheduled || attempt <= config.maxAttempts; attempt += 1) {
      try {
        enforceScheduledWindow(config, scheduled);
        diagnostics.record('attempt-start', { attempt });
        // 上一轮迟到的支付页已经出现时，直接结束，保留支付界面。
        for (const candidate of context.pages()) {
          if (!candidate.isClosed() && hasPaymentInterface(candidate.url(), await pageText(candidate))) {
            result = { outcome: 'payment-ready', page: candidate };
            break;
          }
        }
        if (result) break;
        log(`第 ${attempt}${scheduled ? "（12:03 截止）" : `/${config.maxAttempts}`} 次更新目标日期并检查预约网格……`);
        picks = await attemptBooking(page, config);
        result = await submitOrder(context, page, config, picks, scheduled);
        break;
      } catch (error) {
        diagnostics.record('attempt-error', { attempt, name: error.name, message: error.message, stack: error.stack });
        await diagnostics.snapshot(page, `attempt-${attempt}-error`, { captureImage: false });
        if (!isRetryableBeforeSubmission(error)) throw error;
        const restartEnabled = isAfterChinaNoon();
        consecutiveLoadingFailures = restartEnabled && isLoadingFailure(error) ? consecutiveLoadingFailures + 1 : 0;
        if (restartEnabled && consecutiveLoadingFailures >= 3 && browserRestarts < 2 &&
            (scheduled || attempt < config.maxAttempts)) {
          enforceScheduledWindow(config, scheduled);
          log(`连续 3 次加载失败，关闭本次预约浏览器并重新打开（第 ${++browserRestarts}/2 次）。`);
          // 关闭完成后才重开同一配置目录，避免两个预约实例同时运行。
          await context.close();
          enforceScheduledWindow(config, scheduled);
          context = await launchEdge();
          diagnostics.attach(context);
          context.setDefaultNavigationTimeout(15_000);
          context.setDefaultTimeout(10_000);
          page = await getPage(context);
          consecutiveLoadingFailures = 0;
        }
        const delayMs = retryDelayMs(config, new Date(), error, consecutiveLoadingFailures);
        log(`${error.message}。${scheduled || attempt < config.maxAttempts ? `${delayMs / 1000} 秒后更新场地数据重试。` : "已达到最大重试次数。"}`);
        if (scheduled || attempt < config.maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    if (!result) fail("在重试次数内未确认预约成功。 ");
    diagnostics.record('run-result', { outcome: result.outcome });
    process.stdout.write("\u0007\u0007\u0007");
    const screenshot = await capture(result.page || page, result.outcome);
    log(`页面截图：${screenshot}`);
    await holdOpen(context, config.keepOpenMinutes);
  } catch (error) {
    if (error instanceof ScheduledWindowClosedError) {
      log(`停止尝试：${error.message}。提交记录见本次日志。`);
      diagnostics.record('run-cutoff', { message: error.message });
      await holdOpen(context, config.keepOpenMinutes);
      return;
    }
    process.stdout.write("\u0007\u0007\u0007");
    const screenshot = await capture(page, "error");
    console.error(`\n错误：${error.message}`);
    console.error(`页面截图：${screenshot}`);
    diagnostics.record('run-error', { message: error.message, stack: error.stack });
    console.error(`Edge 会保留 ${config.keepOpenMinutes} 分钟，便于你查看页面提示。`);
    await holdOpen(context, config.keepOpenMinutes);
    process.exitCode = 1;
  }
}

async function checkAuthenticationMode() {
  const config = readConfig();
  const context = await launchEdge();
  context.setDefaultNavigationTimeout(15_000);
  const page = await getPage(context);
  try {
    await openAuthenticatedBookingPage(page, config);
    await waitForGrid(page);
    await saveAuthentication(context, page);
    log("认证检查通过，最新认证信息已保存；未选择场地或提交订单。");
  } catch (error) {
    console.error(`认证检查失败：${error.message}`);
    console.error(`页面截图：${await capture(page, "auth-error")}`);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

async function inspectOrdersMode() {
  const config = readConfig();
  const context = await launchEdge();
  const page = await getPage(context);
  try {
    await page.goto(config.bookingUrl, { waitUntil: "domcontentloaded" });
    await ensureLoggedIn(page);
    const orders = page.getByText("我的订单", { exact: true }).first();
    await orders.click({ timeout: 10_000, noWaitAfter: true });
    await page.waitForTimeout(3_000);
    const body = await pageText(page);
    const relevant = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /2026-10-27|13:00|14:00|待支付|未支付|已支付|已取消|订单/.test(line));
    console.log(relevant.slice(0, 80).join("\n") || "没有识别到目标日期或支付状态文本。 ");
    console.log(`订单页截图：${await capture(page, "order-status")}`);
  } finally {
    await context.close().catch(() => {});
  }
}

function selfTest() {
  assert.equal(isAfterChinaNoon(new Date("2026-10-25T11:59:59+08:00")), false);
  assert.equal(isAfterChinaNoon(new Date("2026-10-25T12:00:00+08:00")), true);
  assert.equal(isLoadingFailure(new RetryableBookingError("认证检查尚未完成，场馆接口仍在响应中")), true);
  assert.equal(isLoadingFailure(new RetryableBookingError("时段 17:00-18:00 暂无可选场地")), false);
  assert.equal(isRetryableBeforeSubmission(new Error("page.goto: net::ERR_ABORTED")), true);
  assert.equal(isLoadingFailure(new AuthenticationExpiredError("请重新登录")), false);
  assert.equal(retryDelayMs({ retryIntervalMs: 1500 }, new Date("2026-10-23T11:59:59+08:00")), 1500);
  assert.equal(retryDelayMs({ retryIntervalMs: 1500 }, new Date("2026-10-23T12:00:00+08:00")), 300);
  assert.equal(retryDelayMs({ retryIntervalMs: 1500 }, new Date("2026-10-23T12:04:59+08:00")), 300);
  const retryNow = new Date("2026-10-23T12:00:01+08:00");
  assert.equal(retryDelayMs({}, retryNow, new RetryableBookingError("网站返回：已被预定"), 0), 300);
  assert.equal(retryDelayMs({}, retryNow, new RetryableBookingError("请求频繁"), 0), 5000);
  assert.equal(retryDelayMs({}, retryNow, new GridNotReadyError("数据未就绪"), 1), 1000);
  assert.equal(retryDelayMs({}, retryNow, new GridNotReadyError("数据未就绪"), 3), 3000);
  const scheduledConfig = { targetDateMode: "auto", targetDate: "2026-10-29", releaseAt: "auto" };
  assert.equal(scheduledSkipReason(scheduledConfig, new Date("2026-10-22T11:59:45+08:00")), null);
  assert.equal(scheduledSkipReason(scheduledConfig, new Date("2026-10-22T12:00:00+08:00")), null);
  assert.equal(scheduledSkipReason(scheduledConfig, new Date("2026-10-22T12:02:59+08:00")), null);
  assert.match(scheduledSkipReason(scheduledConfig, new Date("2026-10-22T12:03:00+08:00")), /截止/);
  assert.match(scheduledSkipReason(scheduledConfig, new Date("2026-10-22T15:09:41+08:00")), /截止/);
  assert.match(scheduledSkipReason(scheduledConfig, new Date("2026-10-22T11:59:44+08:00")), /尚未/);
  assert.match(scheduledSkipReason({ ...scheduledConfig, targetDate: "2026-10-28" }, new Date("2026-10-21T12:00:00+08:00")), /周三/);
  assert.equal(scheduledSkipReason({ ...scheduledConfig, targetDate: "2026-11-01" }, new Date("2026-10-25T12:00:00+08:00")), null);
  const weeklyConfig = { activityType: "健身房", sundayBooking: { activityType: "羽毛球" } };
  assert.equal(applyWeekdayBooking(weeklyConfig, new Date("2026-10-25T11:59:45+08:00")).activityType, "羽毛球");
  assert.equal(applyWeekdayBooking(weeklyConfig, new Date("2026-11-07T11:59:45+08:00")).activityType, "羽毛球");
  assert.equal(applyWeekdayBooking(weeklyConfig, new Date("2026-11-06T11:59:45+08:00")).activityType, "健身房");
  assert.equal(applyWeekdayBooking(weeklyConfig, new Date("2026-10-26T11:59:45+08:00")).activityType, "健身房");
  assert.equal(isRetryableBeforeSubmission(Object.assign(new Error("loading"), { name: "TimeoutError" })), true);
  assert.equal(isRetryableBeforeSubmission(new RetryableBookingError("场馆数据未就绪")), true);
  assert.equal(isRetryableBeforeSubmission(new Error("登录已失效")), false);
  assert.equal(isRetryableBeforeSubmission(new ScheduledWindowClosedError("已过期")), false);
  assert.deepEqual(parseTimeSlot("13:00-14:00"), { slot: "13:00-14:00", rowIndex: 6 });
  assert.equal(seatIndex(8, 6, 0), 48);
  assert.deepEqual(
    courtOrder(["场地1", "场地4（无钢琴）", "场地6"], ["场地6"], ["无钢琴"]),
    [2, 0]
  );
  assert.equal(
    resolveReleaseAt({ targetDate: "2026-10-27", releaseAt: "auto" }),
    "2026-10-20T04:00:00.000Z"
  );
  assert.equal(resolveTargetDate("auto", new Date("2026-10-20T15:30:00+08:00")), "2026-10-27");
  assert.equal(resolveTargetDate("auto", new Date("2026-12-29T23:59:00+08:00")), "2027-01-05");
  assert.equal(resolveTargetDate("2026-11-01"), "2026-11-01");
  assert.equal(hasPaymentInterface("https://sports.sjtu.edu.cn/pc/#/orderDetails/123", "待支付 立即支付"), false);
  assert.equal(hasPaymentInterface("https://pay.sjtu.edu.cn/cashier/123", "订单"), true);
  assert.equal(hasPaymentInterface("https://example.test/", "请使用微信扫码完成付款"), true);
  assert.equal(hasCaptcha("请完成安全验证，向右滑动完成验证"), true);
  console.log("自检通过：定时时间窗口、跳过日期、加载重试、自动目标日期、场地索引和支付页识别均正常。 ");
}

export {
  attemptBooking,
  bookingMode,
  assertAuthenticated, chooseSlots, clickActivityType, clickDate, ensureLoggedIn,
  installAuthenticationGuard, isRetryableBeforeSubmission,
  launchEdge, openAuthenticatedBookingPage, readConfig, readGrid, recoverAuthentication,
  restoreAuthentication, scheduledSkipReason, submitOrder, waitForPaymentInterface, dismissBookingNotice, observeOrderSubmission
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--login")) {
    await loginMode();
  } else if (args.has("--check-auth")) {
    await checkAuthenticationMode();
  } else if (args.has("--check-config")) {
    const config = readConfig();
    console.log("配置检查通过：", JSON.stringify(config, null, 2));
  } else if (args.has("--show-release")) {
    const config = readConfig();
    const releaseAt = resolveReleaseAt(config);
    console.log(`目标日期：${config.targetDate}`);
    console.log(`开抢时间：${releaseAt ? new Date(releaseAt).toLocaleString("zh-CN", { hour12: false }) : "立即开始"}`);
  } else if (args.has("--self-test")) {
    selfTest();
  } else if (args.has("--inspect-orders")) {
    await inspectOrdersMode();
  } else {
    await bookingMode({ scheduled: args.has("--scheduled") });
  }
}
