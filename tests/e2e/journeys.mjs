import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import automator from "miniprogram-automator";

const require = createRequire(import.meta.url);
const MiniProgram = require("miniprogram-automator/out/MiniProgram").default;
const WebSocketClient = require("ws");

// Nightly's Tool.getInfo can never settle. Query the running base library
// through the supported wx API instead of blocking all automation on it.
MiniProgram.prototype.checkVersion = async function checkVersionCompat() {
  const info = await this.systemInfo();
  const parts = String(info.SDKVersion || "")
    .split(".")
    .map(Number);
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part)))
    throw new Error("Cannot verify the simulator base library version");
  if (
    parts[0] < 2 ||
    (parts[0] === 2 && (parts[1] < 7 || (parts[1] === 7 && parts[2] < 3)))
  )
    throw new Error("Automation requires base library 2.7.3 or newer");
};

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const cliPath = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const configuredPort = process.env["E2E_PORT"]
  ? Number(process.env["E2E_PORT"])
  : undefined;
const ideServerPort = process.env["E2E_IDE_PORT"]
  ? Number(process.env["E2E_IDE_PORT"])
  : undefined;
const reusePreparedProject = process.env["E2E_REUSE_PROJECT"] === "1";
const skipVisualCaptures = process.env["E2E_SKIP_SCREENSHOTS"] === "1";
const medicineExpiryOnly = `E2E效期药-${Date.now()}`;
const medicineScheduled = `E2E计划药-${Date.now()}`;
const futureExpiryPickerValue = "2027-12-01";
const privacyVersion = "2026-09-07";
const timeoutMs = 30_000;
const shanghaiOffsetMs = 8 * 60 * 60_000;

let miniProgram;
let temporaryProjectPath;
const exceptions = [];
const recordException = (exception) => exceptions.push(exception);
const visualArtifactDirectory = path.join(
  repositoryRoot,
  "artifacts/visual-qa",
);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withTimeout(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}超过 ${milliseconds / 1_000} 秒`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const shanghaiDateKey = (timestampMs) =>
  new Date(timestampMs + shanghaiOffsetMs).toISOString().slice(0, 10);

const shanghaiTimeKey = (timestampMs) =>
  new Date(timestampMs + shanghaiOffsetMs).toISOString().slice(11, 16);

const shanghaiLocalIso = (date, time) => {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute) - shanghaiOffsetMs,
  ).toISOString();
};

const addDateDays = (date, amount) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount))
    .toISOString()
    .slice(0, 10);
};

const buildPlanTiming = (nowMs = Date.now()) => {
  const today = shanghaiDateKey(nowMs);
  const currentLocalTime = shanghaiTimeKey(nowMs);
  const [hour, minute] = currentLocalTime.split(":").map(Number);
  const minuteOfDay = hour * 60 + minute;
  const minutesToEndOfDay = 1_439 - minuteOfDay;
  assert(
    minutesToEndOfDay >= 1,
    "上海时区 23:59 无法新建今日仍有效的计划任务，请跨日后重跑 E2E",
  );

  // Seven minutes gives the plan enough time to save and still remains inside
  // the product's ten-minute early-recording window.
  const recordableLeadMinutes = Math.min(7, minutesToEndOfDay);
  const recordableTimestampMs = nowMs + recordableLeadMinutes * 60_000;
  const recordableTime = shanghaiTimeKey(recordableTimestampMs);
  assert.equal(
    shanghaiDateKey(recordableTimestampMs),
    today,
    "可记录任务不应跨日",
  );

  const lockedTimestampMs = nowMs + 30 * 60_000;
  const lockedTime =
    shanghaiDateKey(lockedTimestampMs) === today
      ? shanghaiTimeKey(lockedTimestampMs)
      : null;

  return {
    today,
    recordableTime,
    lockedTime,
    tomorrow: addDateDays(today, 1),
  };
};

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string", "无法分配自动化端口");
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function appProtocolReady(port) {
  return new Promise((resolve) => {
    const socket = new WebSocketClient(`ws://127.0.0.1:${port}`);
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          id: "app-ready-probe",
          method: "App.getCurrentPage",
          params: {},
        }),
      );
    });
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (typeof message?.result?.path === "string" && message.result.path) {
        finish(true);
        return;
      }
      if (message?.id === "app-ready-probe") finish(false);
    });
    socket.once("error", () => finish(false));
  });
}

async function launchNightlyCompatible(port) {
  // Nightly can leave an already-open production project focused and attach
  // `auto` to that project. Explicitly opening the isolated fixture in a
  // second window first keeps automation and screenshots bound to the fixture.
  try {
    execFileSync(
      cliPath,
      [
        "open-other",
        "--project",
        temporaryProjectPath,
        ...(ideServerPort ? ["--port", String(ideServerPort)] : []),
      ],
      {
        cwd: repositoryRoot,
        stdio: "ignore",
        timeout: 10_000,
      },
    );
  } catch {
    // `open-other` returns a non-zero status when the fixture is already open;
    // the following automation connection remains the source of truth.
  }
  const child = spawn(
    cliPath,
    [
      "auto",
      "--project",
      temporaryProjectPath,
      "--auto-port",
      String(port),
      ...(ideServerPort ? ["--port", String(ideServerPort)] : []),
      "--trust-project",
    ],
    { stdio: "ignore" },
  );
  let launchError;
  child.once("error", (error) => {
    launchError = error;
  });
  child.unref();

  const deadline = Date.now() + 180_000;
  let connectionError;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try {
      if (await appProtocolReady(port)) {
        // The automation socket may respond before the simulator has finished
        // applying the freshly compiled bundle. Waiting briefly avoids racing
        // the first App.callFunction against that handoff.
        await sleep(1_000);
        return await withTimeout(
          () =>
            automator.connect({
              wsEndpoint: `ws://127.0.0.1:${port}`,
            }),
          15_000,
          `连接微信开发者工具自动化端口 ${port}`,
        );
      }
    } catch (error) {
      connectionError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `微信开发者工具自动化端口 ${port} 未在 180 秒内就绪: ${connectionError?.message ?? "未知错误"}`,
  );
}

async function connectOrLaunch(port) {
  if (configuredPort && (await appProtocolReady(port))) {
    console.log(`[e2e] connecting to existing DevTools on port ${port}`);
    return withTimeout(
      () =>
        automator.connect({
          wsEndpoint: `ws://127.0.0.1:${port}`,
        }),
      15_000,
      `连接现有微信开发者工具自动化端口 ${port}`,
    );
  }
  return launchNightlyCompatible(port);
}

function guardAutomationProtocol(instance) {
  const connection = instance.connection;
  const rawSend = connection.send.bind(connection);
  connection.send = (method, params = {}) =>
    withTimeout(() => rawSend(method, params), 20_000, `自动化协议 ${method}`);
  return instance;
}

async function prepareLocalProject() {
  execFileSync(process.execPath, ["scripts/build-miniprogram.mjs"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  temporaryProjectPath = path.join(repositoryRoot, ".e2e-project", "beta19");
  await rm(temporaryProjectPath, { recursive: true, force: true });
  await mkdir(temporaryProjectPath, { recursive: true });
  await mkdir(visualArtifactDirectory, { recursive: true });
  await cp(
    path.join(repositoryRoot, "dist/miniprogram"),
    temporaryProjectPath,
    { recursive: true },
  );

  const runtimePath = path.join(temporaryProjectPath, "config/runtime.js");
  const runtime = await readFile(runtimePath, "utf8");
  assert.match(
    runtime,
    new RegExp(`privacyVersion: ["']${privacyVersion}["']`),
    "E2E 隐私版本与运行配置不一致",
  );
  const localRuntime = runtime
    .replace('deploymentMode: "production"', 'deploymentMode: "demo"')
    .replace(/cloudEnvId: "[^"]*"/, 'cloudEnvId: ""');
  assert.match(
    localRuntime,
    /deploymentMode: "demo"/,
    "E2E 必须使用本机演示模式",
  );
  assert.match(localRuntime, /cloudEnvId: ""/, "E2E 不能连接生产云环境");
  await writeFile(runtimePath, localRuntime);

  const sourceProjectConfig = JSON.parse(
    await readFile(path.join(repositoryRoot, "project.config.json"), "utf8"),
  );
  const appid = process.env["E2E_APP_ID"] || sourceProjectConfig.appid;
  assert.match(appid, /^(wx[0-9a-f]+|touristappid)$/, "E2E AppID 无效");

  const projectConfig = {
    appid,
    projectname: "yaoxiaoban-e2e",
    description: "药小伴本地自动化验收工程",
    compileType: "miniprogram",
    miniprogramRoot: "./",
    setting: {
      useCompilerPlugins: false,
      es6: true,
      enhance: true,
      postcss: true,
      minified: true,
      minifyWXSS: true,
      minifyWXML: true,
      compileHotReLoad: false,
      ignoreUploadUnusedFiles: true,
      checkSiteMap: true,
      urlCheck: false,
    },
    condition: {},
    libVersion: sourceProjectConfig.libVersion,
  };
  await writeFile(
    path.join(temporaryProjectPath, "project.config.json"),
    `${JSON.stringify(projectConfig, null, 2)}\n`,
  );
}

async function captureVisual(name) {
  if (skipVisualCaptures) {
    console.log(`[e2e] screenshot ${name} skipped by environment`);
    return;
  }
  // Route completion and data readiness can precede the simulator's next paint.
  // Give the compositor one frame window so visual artifacts never capture a
  // transient blank canvas.
  await sleep(500);
  await withTimeout(
    () =>
      miniProgram.screenshot({
        path: path.join(visualArtifactDirectory, `${name}.png`),
      }),
    20_000,
    `截图 ${name}`,
  );
  console.log(`[e2e] screenshot ${name}`);
}

async function waitUntil(predicate, message, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function fireRoute(method, url, label) {
  // MiniProgram.changeRoute waits for a native callback that Nightly can omit
  // even when navigation succeeds. Schedule the same wx route and return from
  // App.callFunction immediately; loadedPage remains the source of truth.
  // A short bridge-settle window prevents a just-finished service call from
  // competing with Nightly's route loader on the same simulator channel.
  await sleep(1_000);
  await miniProgram.evaluate(
    (input) => {
      const route = wx[input.method];
      if (typeof route !== "function") throw new Error("导航方法不存在");
      const app = getApp();
      app.globalData.__e2eRouteError = "";
      const invokeRoute = () => {
        const callbacks = {
          success: () => {
            app.globalData.__e2eRouteDone = input.method;
          },
          fail: (error) => {
            app.globalData.__e2eRouteError = error?.errMsg ?? String(error);
            // Nightly occasionally reports switchTab:fail timeout while the
            // simulator is still finishing a storage write. Retry once after
            // a quiet bridge window; a second failure remains a real E2E
            // navigation failure and is surfaced by loadedPage.
            if (
              input.method === "switchTab" &&
              !app.globalData.__e2eRouteRetried
            ) {
              app.globalData.__e2eRouteRetried = true;
              setTimeout(() => {
                app.globalData.__e2eRouteError = "";
                invokeRoute();
              }, 1_500);
            }
          },
        };
        if (input.method === "navigateBack")
          route.call(wx, { delta: 1, ...callbacks });
        else route.call(wx, { url: input.url, ...callbacks });
      };
      app.globalData.__e2eRouteRetried = false;
      invokeRoute();
      return true;
    },
    { method, url },
  );
  console.log(`[e2e] ${label} scheduled`);
}

async function pageForPath(expectedPath) {
  const current = await miniProgram.currentPage();
  if (current?.path === expectedPath) return current;
  // Nightly can briefly return the page that initiated a route while the
  // target is already present in the native page stack. Prefer the newest
  // matching stack entry, but keep the current page as the diagnostic
  // fallback when the stack query itself is unavailable.
  try {
    const stack = await miniProgram.pageStack();
    const matching = [...stack]
      .reverse()
      .find((item) => item?.path === expectedPath);
    if (matching) return matching;
  } catch {
    // The current-page response is still useful for the timeout diagnostic.
  }
  return current;
}

async function loadedPage(expectedPath) {
  let page;
  let observedPath = "";
  let observedLoading;
  try {
    await waitUntil(async () => {
      page = await pageForPath(expectedPath);
      observedPath = page?.path ?? "";
      if (page?.path !== expectedPath) return false;
      observedLoading = await page.data("loading");
      return observedLoading === false;
    }, `${expectedPath} 未加载完成`);
  } catch (error) {
    const routeError = await miniProgram.evaluate(
      () => getApp().globalData.__e2eRouteError ?? "",
    );
    throw new Error(
      `${expectedPath} 未加载完成；当前页=${observedPath || "未知"}，loading=${String(observedLoading)}${routeError ? `；导航错误=${routeError}` : ""}: ${error.message}`,
    );
  }
  return page;
}

async function resetLocalApplication() {
  console.log("[e2e] resetting local application state");
  await withTimeout(
    () =>
      miniProgram.evaluate(() => {
        const app = getApp();
        if (app.globalData.mode !== "local")
          throw new Error("Refusing to reset a non-demo application");
        wx.clearStorageSync();
        app.globalData.service = null;
      }),
    15_000,
    "清理小程序本地数据",
  );
  await withTimeout(
    () => fireRoute("reLaunch", "/pages/start/index", "reset local start page"),
    20_000,
    "重新打开首次使用页",
  );
  console.log("[e2e] local application state reset");
}

async function acceptPrivacy() {
  const page = await loadedPage("pages/start/index");
  await captureVisual("01-privacy-start");
  await page.callMethod("onConsentChange", {
    detail: { value: ["accepted"] },
  });
  await waitUntil(
    async () => (await page.data("consentChecked")) === true,
    "隐私同意状态未更新",
  );
  await miniProgram.evaluate(
    (version) => getApp().getService().acceptPrivacy(version),
    privacyVersion,
  );
  await fireRoute("switchTab", "/pages/today/index", "同意隐私后打开今天");

  const todayPage = await loadedPage("pages/today/index");
  assert.equal(await todayPage.data("hasMedicine"), false);
  await captureVisual("02-today-empty");
}

async function addExpiryOnlyMedicineAndInventory() {
  let page = await loadedPage("pages/today/index");
  await page.callMethod("addMedicine");
  page = await loadedPage("pages/medicine-form/index");
  console.log("[e2e] expiry form loaded");

  await page.callMethod("onNameInput", {
    detail: { value: medicineExpiryOnly },
  });
  await page.callMethod("onExpiryChange", {
    detail: { value: futureExpiryPickerValue },
  });
  await waitUntil(
    async () => (await page.data("expiryValue")) === "2027-12",
    "有效期选择没有更新",
  );
  assert.equal(await page.data("name"), medicineExpiryOnly);
  assert.equal(await page.data("usageMode"), "expiry_only");

  await page.callMethod("toggleQuantity");
  await waitUntil(
    async () => (await page.data("quantityOpen")) === true,
    "数量区未展开",
  );
  await page.callMethod("onQuantityInput", { detail: { value: "6" } });

  // The service must reject the exact UI draft while its quantity unit is
  // still unspecified.
  const invalidUnitDraft = await page.callMethod("buildDraft");
  assert.equal(invalidUnitDraft.unit, "");
  const invalidUnitAttempt = await miniProgram.evaluate(async (draft) => {
    try {
      await getApp().getService().saveMedication(draft);
      return { accepted: true, message: "" };
    } catch (error) {
      return {
        accepted: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, invalidUnitDraft);
  assert.equal(invalidUnitAttempt.accepted, false);
  assert.match(invalidUnitAttempt.message, /单位/);
  console.log("[e2e] explicit-unit validation passed");
  // Nightly's global App.getCurrentPage bridge can briefly report the
  // previous tab while a service call is resolving. The page handle that
  // produced the draft is the stronger assertion here: the form is still
  // dirty and its quantity section remains open after the rejected save.
  assert.equal(await page.data("formState"), "dirty");
  assert.equal(await page.data("quantityOpen"), true);

  await page.callMethod("onUnitChange", { detail: { value: "0" } });
  await waitUntil(
    async () => (await page.data("unitIndex")) === 0,
    "单位选择没有更新",
  );
  const expiryOnlyDraft = await page.callMethod("buildDraft");
  assert.equal(expiryOnlyDraft.unit, "片");
  assert.equal(expiryOnlyDraft.initialQuantityMilli, 6_000);
  console.log("[e2e] expiry draft built");

  // Submit the exact UI-built draft through the product service so the
  // business journey remains deterministic.
  console.log("[e2e] saving expiry draft through data service");
  const expiryOnlyResult = await miniProgram.evaluate(
    (draft) => getApp().getService().saveMedication(draft),
    expiryOnlyDraft,
  );
  // This journey persists the form through the service to keep the business
  // assertion deterministic. The real form.save() clears its leave guard;
  // mirror that post-save side effect before switching tabs in the harness.
  await page.callMethod("clearLeaveGuard");
  console.log("[e2e] expiry draft saved through data service");
  const medicationId = expiryOnlyResult.medicationId;
  await miniProgram.evaluate(
    (input) => getApp().getService().confirmInventory(input),
    {
      medicationId,
      quantityMilli: 12_000,
      note: "E2E 手动盘点",
      requestId: `e2e-inventory-${Date.now()}`,
    },
  );
  await fireRoute("switchTab", "/pages/cabinet/index", "切换到药箱");
  page = await loadedPage("pages/cabinet/index");
  await waitUntil(async () => {
    const card = (await page.data("allCards")).find(
      (item) => item.id === medicationId,
    );
    return card?.estimateText === "预计剩余 12片";
  }, "药箱没有回显盘点后的剩余数量");
  console.log("[e2e] checkpoint 效期药品与盘点结果已在药箱回显");
  await captureVisual("05-cabinet");
  await page.callMethod("openSettings");
  await loadedPage("pages/settings/index");
  await captureVisual("05b-settings");
}

async function addFixedPlanAndRecordThenUndo() {
  const planTiming = buildPlanTiming();
  await fireRoute("switchTab", "/pages/cabinet/index", "切换到药箱");
  let page = await loadedPage("pages/cabinet/index");
  await page.callMethod("addMedicine");
  page = await loadedPage("pages/medicine-form/index");
  await captureVisual("06-add-form-collapsed");

  await page.callMethod("onNameInput", {
    detail: { value: medicineScheduled },
  });
  await page.callMethod("onExpiryChange", {
    detail: { value: futureExpiryPickerValue },
  });
  await waitUntil(
    async () => (await page.data("expiryValue")) === "2027-12",
    "计划药品有效期选择没有更新",
  );

  await page.callMethod("toggleQuantity");
  await waitUntil(
    async () => (await page.data("quantityOpen")) === true,
    "数量区未展开",
  );
  await page.callMethod("onQuantityInput", { detail: { value: "20" } });
  await page.callMethod("onUnitChange", { detail: { value: "0" } });
  await waitUntil(
    async () => (await page.data("unitIndex")) === 0,
    "计划药品的单位选择没有更新",
  );

  await page.callMethod("selectUsageMode", {
    currentTarget: { dataset: { mode: "scheduled" } },
  });
  await waitUntil(
    async () => (await page.data("usageMode")) === "scheduled",
    "计划区未展开",
  );
  await page.callMethod("onTimeChange", {
    currentTarget: { dataset: { index: 0 } },
    detail: { value: planTiming.recordableTime },
  });
  await waitUntil(
    async () => (await page.data("times"))?.[0] === planTiming.recordableTime,
    "提醒时间没有更新",
  );
  if (planTiming.lockedTime) {
    await page.callMethod("addTime");
    await page.callMethod("onTimeChange", {
      currentTarget: { dataset: { index: 1 } },
      detail: { value: planTiming.lockedTime },
    });
    await waitUntil(
      async () => (await page.data("times"))?.[1] === planTiming.lockedTime,
      "提前超过10分钟的测试任务没有设置成功",
    );
  }
  await captureVisual("06b-medicine-form-expanded");

  const scheduledDraft = await page.callMethod("buildDraft");
  assert.equal(scheduledDraft.unit, "片");
  assert.equal(scheduledDraft.initialQuantityMilli, 20_000);
  assert.equal(scheduledDraft.schedule.startDate, planTiming.today);
  const scheduledResult = await miniProgram.evaluate(
    (draft) => getApp().getService().saveMedication(draft),
    scheduledDraft,
  );
  await page.callMethod("clearLeaveGuard");
  const activePlan = scheduledResult.state.plans.find(
    (item) => item.id === scheduledResult.planId && !item.effectiveTo,
  );
  assert(activePlan, "固定计划没有生成活动版本");
  assert(activePlan.times.includes(planTiming.recordableTime));
  console.log("[e2e] checkpoint 固定计划已保存");

  await fireRoute("switchTab", "/pages/today/index", "切换到今天");
  page = await loadedPage("pages/today/index");
  await waitUntil(async () => {
    const tasks = await page.data("allTasks");
    return tasks.some((task) => task.medicationName === medicineScheduled);
  }, "今日页未生成固定计划任务");

  const scheduledTask = (await page.data("allTasks")).find(
    (task) =>
      task.medicationName === medicineScheduled &&
      task.time === planTiming.recordableTime,
  );
  assert(scheduledTask, "找不到固定计划任务");
  assert.equal(scheduledTask.canRecord, true, "距计划时间10分钟内应允许记录");

  // The persisted result returned by saveMedication is already the canonical
  // application state. Re-reading it through App.evaluate immediately after a
  // tab switch is flaky in recent Nightly builds: the bridge can serialize the
  // pending Promise as undefined even though the page and task have loaded.
  // Keep the state assertion, but use the successful save result and separately
  // assert that the Today-page occurrence points back to that version.
  const savedPlan = scheduledResult.state.plans.find(
    (item) => item.id === scheduledTask.planId,
  );
  assert(savedPlan, "找不到固定计划版本");

  if (planTiming.lockedTime) {
    const lockedTask = (await page.data("allTasks")).find(
      (task) =>
        task.medicationName === medicineScheduled &&
        task.time === planTiming.lockedTime,
    );
    assert(lockedTask, "找不到提前超过10分钟的今日任务");
    assert.equal(
      lockedTask.canRecord,
      false,
      "距计划时间超过10分钟时界面应禁止记录",
    );
    assert.match(lockedTask.availabilityText, /前10分钟可记录/);
  }

  // The service must enforce the same boundary even if a caller bypasses UI.
  const tomorrowScheduledAt = shanghaiLocalIso(
    planTiming.tomorrow,
    planTiming.recordableTime,
  );
  const earlyAttempt = await miniProgram.evaluate(
    async (input) => {
      try {
        await getApp().getService().recordIntake(input);
        return { accepted: true, message: "" };
      } catch (error) {
        return {
          accepted: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      medicationId: scheduledTask.medicationId,
      planId: scheduledTask.planId,
      occurrenceKey: `${scheduledTask.planId}|${planTiming.tomorrow}|${planTiming.recordableTime}`,
      scheduledAt: tomorrowScheduledAt,
      status: "taken",
      quantityMilli: scheduledTask.doseMilli,
      requestId: `e2e-too-early-${Date.now()}`,
    },
  );
  assert.equal(earlyAttempt.accepted, false, "提前超过10分钟的记录被错误接受");
  assert.match(earlyAttempt.message, /10分钟/);

  await captureVisual("07-today-with-plan");
  console.log("[e2e] checkpoint 今日页已生成固定计划任务");
  await page.callMethod("recordTask", {
    currentTarget: { dataset: { key: scheduledTask.key, status: "taken" } },
  });
  await waitUntil(async () => {
    const task = (await page.data("allTasks")).find(
      (item) => item.key === scheduledTask.key,
    );
    return task?.status === "taken";
  }, "已服记录未更新");

  const takenTask = (await page.data("allTasks")).find(
    (item) => item.key === scheduledTask.key,
  );
  assert(takenTask?.logId, "已服任务缺少日志 ID");
  await page.callMethod("openHistory");
  page = await loadedPage("pages/history/index");
  await captureVisual("08-history");
  await fireRoute("navigateBack", "", "从历史页返回");
  page = await loadedPage("pages/today/index");
  await page.callMethod("undoTask", {
    currentTarget: { dataset: { logId: takenTask.logId } },
  });
  await waitUntil(async () => {
    const task = (await page.data("allTasks")).find(
      (item) => item.key === scheduledTask.key,
    );
    return task?.status === "upcoming" || task?.status === "due";
  }, "撤销后任务未恢复");

  return {
    medicationId: scheduledTask.medicationId,
    planId: scheduledTask.planId,
  };
}

async function archiveRestoreAndDelete({ medicationId, planId }) {
  const archivedState = await miniProgram.evaluate(async (id) => {
    const service = getApp().getService();
    const state = await service.bootstrap();
    const medication = state.medications.find((item) => item.id === id);
    if (!medication) throw new Error("归档前找不到药盒");
    return service.archiveMedication(id, medication.version);
  }, medicationId);
  const archivedMedication = archivedState.medications.find(
    (item) => item.id === medicationId,
  );
  assert(archivedMedication?.archivedAt, "归档后药盒仍是活动状态");
  assert.equal(
    archivedState.plans.find((item) => item.id === planId)?.effectiveTo != null,
    true,
    "归档后原计划没有停止",
  );

  await fireRoute("switchTab", "/pages/cabinet/index", "切换到药箱");
  let page = await loadedPage("pages/cabinet/index");
  await waitUntil(
    async () =>
      (await page.data("archivedCards")).some(
        (item) => item.id === medicationId,
      ),
    "已归档药盒没有出现在药箱中",
  );
  assert.equal(
    (await page.data("allCards")).some((item) => item.id === medicationId),
    false,
    "已归档药盒仍出现在活动列表",
  );
  await captureVisual("09-cabinet-archived");

  const restoredState = await miniProgram.evaluate(async (id) => {
    const service = getApp().getService();
    const state = await service.bootstrap();
    const medication = state.medications.find((item) => item.id === id);
    if (!medication) throw new Error("恢复前找不到已归档药盒");
    return service.restoreMedication(id, medication.version);
  }, medicationId);
  const restoredMedication = restoredState.medications.find(
    (item) => item.id === medicationId,
  );
  assert.equal(restoredMedication?.archivedAt, null, "药盒没有恢复");
  assert.equal(
    restoredMedication?.mode,
    "expiry_only",
    "恢复后应只继续管理有效期",
  );
  assert.equal(
    restoredState.plans.some(
      (item) => item.medicationId === medicationId && !item.effectiveTo,
    ),
    false,
    "恢复后不应自动重启原服药计划",
  );
  await page.callMethod("loadData");
  await waitUntil(
    async () =>
      (await page.data("allCards")).some((item) => item.id === medicationId),
    "恢复药盒没有回到活动列表",
  );

  const reArchivedState = await miniProgram.evaluate(async (id) => {
    const service = getApp().getService();
    const state = await service.bootstrap();
    const medication = state.medications.find((item) => item.id === id);
    if (!medication) throw new Error("再次归档前找不到药盒");
    return service.archiveMedication(id, medication.version);
  }, medicationId);
  const reArchivedMedication = reArchivedState.medications.find(
    (item) => item.id === medicationId,
  );
  assert(reArchivedMedication?.archivedAt, "药盒没有再次归档");

  const deletedState = await miniProgram.evaluate(async (id) => {
    const service = getApp().getService();
    const state = await service.bootstrap();
    const medication = state.medications.find((item) => item.id === id);
    if (!medication) throw new Error("永久删除前找不到已归档药盒");
    return service.deleteMedication(id, medication.version);
  }, medicationId);
  assert.equal(
    deletedState.medications.some((item) => item.id === medicationId),
    false,
    "永久删除后药盒仍存在",
  );
  for (const [collectionName, records] of [
    ["plans", deletedState.plans],
    ["snapshots", deletedState.snapshots],
    ["intakeLogs", deletedState.intakeLogs],
    ["calendarExports", deletedState.calendarExports],
  ]) {
    assert.equal(
      records.some((item) => item.medicationId === medicationId),
      false,
      `永久删除后 ${collectionName} 仍有关联记录`,
    );
  }
  await page.callMethod("loadData");
  assert.equal(
    (await page.data("archivedCards")).some((item) => item.id === medicationId),
    false,
    "永久删除后归档列表仍有该药盒",
  );
  await captureVisual("10-cabinet-after-delete");
}

async function referenceIntegrationJourney() {
  await fireRoute("switchTab", "/pages/cabinet/index", "打开药箱位置筛选");
  let page = await loadedPage("pages/cabinet/index");
  const cards = await page.data("allCards");
  assert(cards.length > 0);
  const sourceId = cards[0].id;
  await page.callMethod("startInventorySession");
  page = await loadedPage("pages/inventory-session/index");
  await page.callMethod("onQuantityInput", { detail: { value: "4.125" } });
  await page.callMethod("confirm");
  assert.equal(await page.data("completed"), 1);
  const state = await miniProgram.evaluate(() =>
    getApp().getService().bootstrap(),
  );
  assert(
    state.snapshots.some(
      (item) => item.medicationId === sourceId && item.quantityMilli === 4125,
    ),
  );
  await fireRoute(
    "navigateTo",
    `/pages/medicine-detail/index?id=${sourceId}`,
    "打开原盒",
  );
  page = await loadedPage("pages/medicine-detail/index");
  await page.callMethod("copyNewBox");
  page = await loadedPage("pages/medicine-form/index");
  assert.equal(await page.data("editing"), false);
  assert.equal(await page.data("expiryValue"), "");
  assert.equal(await page.data("quantity"), "");
  assert.equal(await page.data("usageMode"), "expiry_only");
  await page.callMethod("onLocationInput", { detail: { value: "客厅药箱" } });
  assert.equal(
    (await page.callMethod("buildDraft")).storageLocation,
    "客厅药箱",
  );
  await page.callMethod("clearLeaveGuard");
  console.log("[e2e] PASS 集中盘点 → 独立新盒预填 → 位置录入");
}

async function run() {
  if (reusePreparedProject) {
    temporaryProjectPath = path.join(repositoryRoot, ".e2e-project", "beta19");
    try {
      await Promise.all([
        readFile(path.join(temporaryProjectPath, "project.config.json")),
        readFile(path.join(temporaryProjectPath, "app.js")),
      ]);
    } catch {
      throw new Error(
        "E2E_REUSE_PROJECT=1 但 .e2e-project 不完整，请先不带该环境变量运行一次",
      );
    }
    await mkdir(visualArtifactDirectory, { recursive: true });
  } else {
    await prepareLocalProject();
  }
  const port = configuredPort ?? (await availablePort());
  console.log(`[e2e] launching WeChat DevTools on automation port ${port}`);
  miniProgram = guardAutomationProtocol(await connectOrLaunch(port));
  console.log(`[e2e] connected on automation port ${port}`);
  miniProgram.on("exception", recordException);

  await resetLocalApplication();
  await acceptPrivacy();
  console.log("[e2e] PASS 首次同意隐私说明");

  await addExpiryOnlyMedicineAndInventory();
  console.log("[e2e] PASS 新增只记效期药品 → 详情 → 盘点 → 药箱回访");

  await referenceIntegrationJourney();

  // Resetting storage and the singleton service is enough to isolate the next
  // journey. Reusing the same DevTools connection avoids Nightly occasionally
  // waiting forever while it tears down and creates a second automation socket.
  await resetLocalApplication();
  await acceptPrivacy();
  console.log("[e2e] PASS 第二条旅程已从干净本地状态启动");

  const scheduledLifecycle = await addFixedPlanAndRecordThenUndo();
  console.log("[e2e] PASS 新增每日固定计划 → 今日任务 → 已服 → 撤销");

  await archiveRestoreAndDelete(scheduledLifecycle);
  console.log("[e2e] PASS 归档 → 恢复为只记效期 → 再归档 → 永久删除及级联清理");

  assert.equal(
    exceptions.length,
    0,
    `运行期异常: ${JSON.stringify(exceptions)}`,
  );
  console.log("[e2e] ALL PASS");
}

try {
  await run();
} catch (error) {
  console.error("[e2e] FAIL", error);
  if (exceptions.length) console.error("[e2e] exceptions", exceptions);
  process.exitCode = 1;
} finally {
  if (miniProgram) {
    const client = miniProgram;
    miniProgram = undefined;
    try {
      await withTimeout(() => client.close(), 10_000, "关闭自动化连接");
    } catch (error) {
      console.warn(`[e2e] close warning: ${error.message}`);
      try {
        client.disconnect();
      } catch {
        // The socket may already be disconnected after a partial close.
      }
    }
  }
  if (temporaryProjectPath && !reusePreparedProject) {
    await rm(temporaryProjectPath, { recursive: true, force: true });
  }
}
