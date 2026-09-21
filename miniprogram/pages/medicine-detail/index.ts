import { saveJobView } from "../../services/save-job-view";
import { buildReminderHealth } from "../../services/reminder-health";
import { getSaveQueue } from "../../services/save-queue";
import {
  createPhotoAttempt,
  recordPhotoEvent,
} from "../../services/diagnostics";
import {
  dateKeyFromMs,
  timeKeyFromMs,
  localDateTimeToIso,
  isValidDateKey,
  isValidTimeKey,
  daysBetween,
  formatChineseDate,
  formatDose,
  formatLocalDateTime,
  formatShortChineseDate,
  todayKey,
} from "../../core/dates";
import { resolveExpiry } from "../../core/expiry";
import { estimateInventory } from "../../core/inventory";
import type { AppState, Medication, PlanVersion } from "../../core/models";
import { expandOccurrences } from "../../core/schedule";
import { createRequestId } from "../../core/id";
import { RUNTIME_CONFIG } from "../../config/runtime";
import {
  openCalendarPermissionSettings,
  writePlanToCalendar,
} from "../../services/calendar";
import { reminderStatus } from "../../services/reminder-status";
import { requestSubscriptionForKind } from "../../services/subscription";
import type { ReminderKind, ReminderStatus } from "../../services/data-service";
import { confirm, showError } from "../../services/ui";

interface DetailView {
  mode: string;
  openingText: string;
  photoUrl: string;
  photoFullUrl: string;
  reminderCoverage: string;
  oldCalendarText: string;
  reminderAction: string;
  recordLabel: string;
  recentUsage: { id: string; version: number; text: string }[];
  id: string;
  name: string;
  profileName: string;
  specification: string;
  storageLocation: string;
  expiryText: string;
  effectiveExpiryText: string;
  expirySourceText: string;
  expiryStatusText: string;
  expiryStatusClass: string;
  expiryNoticeTitle: string;
  expiryNoticeCopy: string;
  isExpired: boolean;
  stockValue: string;
  stockCaption: string;
  stockRisk: string;
  shortageDate: string;
  stockBasis: string;
  snapshotText: string;
  openingValue: string;
  expiryReminderCopy: string;
  shortageReminderCopy: string;
  estimateText: string;
  depletionText: string;
  estimateBasisText: string;
  planText: string;
  nextText: string;
  calendarText: string;
  calendarClass: string;
  hasPlan: boolean;
  hasFixedPlan: boolean;
  note: string;
  unit: string;
  defaultDose: string;
  canTrackQuantity: boolean;
}

const latestPlan = (
  state: AppState,
  medicationId: string,
): PlanVersion | null =>
  state.plans.find(
    (item) => item.medicationId === medicationId && item.effectiveTo === null,
  ) ?? null;

const buildView = (
  state: AppState,
  medication: Medication,
  nowMs: number,
): DetailView => {
  const profile = state.profiles.find(
    (item) => item.id === medication.profileId,
  );
  const plan = latestPlan(state, medication.id);
  const expiry = resolveExpiry(medication);
  const effectiveDate = expiry.effectiveExpiryDate;
  const estimate = estimateInventory({
    medicationId: medication.id,
    plans: state.plans,
    snapshots: state.snapshots,
    logs: state.intakeLogs,
    asOfMs: nowMs,
    stopAtDate: effectiveDate,
  });
  const next = expandOccurrences(
    state.plans,
    nowMs + 1,
    nowMs + 366 * 86_400_000,
    medication.id,
  ).find((occurrence) => occurrence.localDate <= effectiveDate);
  const snapshot = state.snapshots
    .filter((item) => item.medicationId === medication.id)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
  const reminder = reminderStatus(state, medication, nowMs);
  let depletionText = "记录数量后可估算用完时间";
  if (estimate.reason === "as-needed")
    depletionText = "按需使用，无法预测用完时间";
  else if (estimate.reason === "no-plan")
    depletionText = "没有固定计划，无法预测用完时间";
  else if (estimate.firstShortageAt) {
    depletionText = `预计${formatShortChineseDate(dateKeyFromMs(Date.parse(estimate.firstShortageAt)))}起不足`;
  } else if (
    estimate.reason === "plan-ended" &&
    estimate.currentQuantityMilli !== null
  ) {
    depletionText = "计划结束时仍有预计余量";
  }
  let planText = "未设置服药计划";
  if (plan?.scheduleType === "as_needed")
    planText = `按需使用 · 每次${formatDose(plan.doseMilli, medication.unit)}`;
  else if (plan) {
    const repeat = plan.scheduleType === "daily" ? "每天" : "指定星期";
    planText = `${repeat} ${plan.times.join("、")} · 每次${formatDose(plan.doseMilli, medication.unit)}`;
  }
  const remainingDays = daysBetween(todayKey(nowMs), effectiveDate);
  const expiryStatusText =
    remainingDays < 0
      ? "已超过管理期限"
      : remainingDays === 0
        ? "今天到期"
        : remainingDays <= state.settings.expiryLeadDays
          ? `还有${remainingDays}天`
          : `距到期 ${remainingDays} 天`;
  return {
    mode: medication.mode,
    openingText: medication.openedDate
      ? `开封日期：${formatChineseDate(medication.openedDate)}`
      : "未记录开封日期",
    id: medication.id,
    name: medication.name,
    profileName: profile?.name ?? "成员",
    specification: medication.specification || "未填写规格",
    storageLocation: medication.storageLocation || "未填写位置",
    expiryText: formatChineseDate(
      medication.expiryValue,
      medication.expiryPrecision,
    ),
    effectiveExpiryText: formatChineseDate(effectiveDate),
    expirySourceText:
      expiry.source === "after-open"
        ? "按包装有效期与开封期限中较早者计算"
        : medication.expiryPrecision === "month"
          ? "包装只标到月份，按当月最后一天管理"
          : "按包装完整日期管理",
    expiryStatusText,
    expiryStatusClass:
      remainingDays < 0
        ? "danger"
        : remainingDays <= state.settings.expiryLeadDays
          ? "warning"
          : "normal",
    expiryNoticeTitle: `${medication.name} 已超过管理期限`,
    expiryNoticeCopy:
      expiry.source === "after-open"
        ? `管理期限已于${formatChineseDate(effectiveDate)}结束，原因是开封后期限更早。请核对日期或移除这盒药。`
        : `包装标注的管理期限已于${formatChineseDate(effectiveDate)}结束。请核对日期或移除这盒药。`,
    isExpired: remainingDays < 0,
    stockValue:
      estimate.currentQuantityMilli === null
        ? "尚未盘点"
        : formatDose(estimate.currentQuantityMilli, medication.unit),
    stockCaption:
      estimate.currentQuantityMilli === null
        ? "盘点后查看预计余量"
        : "预计剩余",
    stockRisk:
      estimate.currentQuantityMilli === 0
        ? "danger"
        : estimate.firstShortageAt &&
            daysBetween(
              todayKey(nowMs),
              dateKeyFromMs(Date.parse(estimate.firstShortageAt)),
            ) <= state.settings.lowStockLeadDays
          ? "warning"
          : "normal",
    shortageDate: estimate.firstShortageAt
      ? formatShortChineseDate(
          dateKeyFromMs(Date.parse(estimate.firstShortageAt)),
        )
      : "",
    stockBasis: snapshot ? "按当前计划估算" : "盘点一次后，建立预计余量基线",
    snapshotText: snapshot
      ? `${formatShortChineseDate(dateKeyFromMs(Date.parse(snapshot.recordedAt)))} ${timeKeyFromMs(Date.parse(snapshot.recordedAt))}`
      : "",
    openingValue: medication.openedDate
      ? formatChineseDate(medication.openedDate)
      : "未记录",
    expiryReminderCopy: `提前 ${state.settings.expiryLeadDays} 天提醒`,
    shortageReminderCopy: `预计不足前 ${state.settings.lowStockLeadDays} 天提醒`,
    estimateText:
      estimate.currentQuantityMilli === null
        ? "尚未盘点"
        : `预计剩余 ${formatDose(estimate.currentQuantityMilli, medication.unit)}`,
    depletionText,
    estimateBasisText: snapshot
      ? `按计划估算 · 上次盘点 ${formatLocalDateTime(snapshot.recordedAt)}`
      : "盘点一次后，才能建立预计余量基线",
    planText,
    nextText: next
      ? `下一次 ${formatShortChineseDate(next.localDate)} ${next.time}`
      : "没有后续固定计划",
    calendarText: reminder.text,
    calendarClass: "muted",
    reminderCoverage: reminder.coverage,
    oldCalendarText: reminder.oldCalendarText,
    reminderAction: reminder.action,
    photoUrl:
      medication.photo?.thumbnailUrl ??
      medication.photo?.url ??
      medication.photo?.fileId ??
      "",
    photoFullUrl: medication.photo?.url ?? medication.photo?.fileId ?? "",
    recordLabel:
      medication.mode === "as_needed"
        ? "记录本次使用"
        : medication.mode === "scheduled"
          ? "记录计划外使用"
          : "",
    recentUsage: state.intakeLogs
      .filter(
        (log) =>
          log.medicationId === medication.id &&
          log.status === "extra" &&
          !log.voidedAt,
      )
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .slice(0, 3)
      .map((log) => ({
        id: log.id,
        version: log.version,
        text: `${formatLocalDateTime(log.occurredAt)} · ${formatDose(log.quantityMilli, medication.unit)}`,
      })),
    hasPlan: Boolean(plan),
    hasFixedPlan: Boolean(plan && plan.scheduleType !== "as_needed"),
    note: medication.note,
    unit: medication.unit,
    defaultDose: plan ? String(plan.doseMilli / 1000) : "1",
    canTrackQuantity: Boolean(medication.unit),
  };
};

Page({
  data: {
    photoSyncText: "",
    reminderHealth: buildReminderHealth(null),
    photoLoadStartedAtMs: 0,
    photoLoadAttemptId: "",
    savedNotice: false,
    loading: true,
    error: "",
    medicationId: "",
    view: null as DetailView | null,
    medicationVersion: 0,
    busy: false,
    reminderOpen: false,
    reminderState: null as ReminderStatus | null,
    doseReminderStatus: "读取中",
    expiryReminderStatus: "待配置",
    shortageReminderStatus: "待配置",
    recordOpen: false,
    recordQuantity: "",
    recordDate: "",
    recordTime: "",
    recordError: "",
    recordRequestId: "",
    today: todayKey(),
  },

  onLoad(options: Record<string, string | undefined>) {
    this.setData({
      medicationId: options["id"] ?? "",
      savedNotice: options["saved"] === "1",
    });
  },

  openPendingSaves() {
    void wx.navigateTo({ url: "/pages/sync/index" });
  },

  async onShow() {
    await this.loadData();
  },

  copyNewBox() {
    void wx.navigateTo({
      url: `/pages/medicine-form/index?copyFrom=${encodeURIComponent(this.data.medicationId)}`,
    });
  },
  async loadData() {
    this.setData({ loading: true, error: "" });
    try {
      const state = await getApp<IAppOption>().getService().bootstrap();
      const pendingPhoto = getSaveQueue(getApp<IAppOption>().getService())
        .list()
        .find(
          (job) =>
            job.status !== "ready" &&
            (job.medicationId === this.data.medicationId ||
              job.draft.id === this.data.medicationId),
        );
      this.setData({
        photoSyncText: pendingPhoto ? saveJobView(pendingPhoto).message : "",
      });
      const medication = state.medications.find(
        (item) => item.id === this.data.medicationId,
      );
      if (!medication || medication.archivedAt)
        throw new Error("这个药盒已经不存在");
      void wx.setNavigationBarTitle({ title: medication.name });
      // Medication, inventory and photo are already available; reminders must
      // not delay the first usable detail render.
      this.setData({
        loading: false,
        view: buildView(state, medication, Date.now()),
        photoLoadStartedAtMs: Date.now(),
        photoLoadAttemptId: medication.photo ? createPhotoAttempt() : "",
        medicationVersion: medication.version,
      });
      const service = getApp<IAppOption>().getService();
      const reminderState =
        typeof service.getReminderStatus === "function"
          ? await service
              .getReminderStatus(this.data.medicationId)
              .catch(() => null)
          : null;
      this.setData({
        loading: false,
        view: buildView(state, medication, Date.now()),
        medicationVersion: medication.version,
        reminderState,
        reminderHealth: buildReminderHealth(reminderState),
        doseReminderStatus: reminderState
          ? reminderState.grants.dose.usableCount
            ? "已授权下一条"
            : "可申请一次授权"
          : "读取失败，可稍后重试",
        expiryReminderStatus: RUNTIME_CONFIG.subscriptionTemplates.expiry
          ? reminderState?.grants.expiry.usableCount
            ? "已授权下一条"
            : "可申请一次授权"
          : "待配置",
        shortageReminderStatus: RUNTIME_CONFIG.subscriptionTemplates.lowStock
          ? reminderState?.grants.shortage.usableCount
            ? "已授权下一条"
            : "可申请一次授权"
          : "待配置",
      });
    } catch (error) {
      this.setData({
        loading: false,
        error: error instanceof Error ? error.message : "没有加载成功",
      });
    }
  },

  edit() {
    void wx.navigateTo({
      url: `/pages/medicine-form/index?id=${this.data.medicationId}`,
    });
  },

  async inventory() {
    if (!this.data.view?.canTrackQuantity) {
      const decision = await wx.showModal({
        title: "先设置数量单位",
        content: "为了避免把滴、毫升或粒误记成片，请先在编辑页选择实际单位。",
        cancelText: "暂不设置",
        confirmText: "去设置",
        confirmColor: "#167A50",
      });
      if (decision.confirm) this.edit();
      return;
    }
    void wx.navigateTo({
      url: `/pages/inventory/index?id=${this.data.medicationId}`,
    });
  },

  history() {
    void wx.navigateTo({
      url: `/pages/history/index?id=${this.data.medicationId}`,
    });
  },

  openReminders() {
    this.setData({ reminderOpen: true });
  },

  closeReminders() {
    if (!this.data.busy) this.setData({ reminderOpen: false });
  },

  async requestWechatReminder(
    event: WechatMiniprogram.CustomEvent<{ kind: ReminderKind }>,
  ) {
    const kind = event.detail.kind;
    const templateId =
      kind === "dose"
        ? RUNTIME_CONFIG.subscriptionTemplates.dose
        : kind === "expiry"
          ? RUNTIME_CONFIG.subscriptionTemplates.expiry
          : RUNTIME_CONFIG.subscriptionTemplates.lowStock;
    if (!templateId) {
      await wx.showModal({
        title: "该提醒待配置",
        content:
          "当前后台还没有为这类提醒配置合适的微信模板。手机日历或小程序内提示仍可使用。",
        showCancel: false,
        confirmText: "知道了",
      });
      return;
    }
    if (kind === "dose" && !this.data.view?.hasFixedPlan) {
      await wx.showModal({
        title: "先设置固定服药时间",
        content: "按需使用不会生成固定服药时间提醒。",
        showCancel: false,
        confirmText: "知道了",
      });
      return;
    }
    try {
      const result = await requestSubscriptionForKind(
        kind,
        getApp<IAppOption>().getService(),
        this.data.medicationId,
      );
      await this.loadData();
      await wx.showModal({
        title: result.accepted.length ? "已记录本次授权" : "未获得本次授权",
        content: result.accepted.length
          ? "这次微信授权只用于一条对应提醒；之后需要再次订阅。手机日历仍可提供持续提醒。"
          : "你拒绝了本次微信授权，药盒和手机日历不受影响。",
        showCancel: false,
        confirmText: "知道了",
      });
    } catch (error) {
      showError(error, "微信提醒授权没有完成");
    }
  },

  async addCalendar() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const state = await getApp<IAppOption>().getService().bootstrap();
      const medication = state.medications.find(
        (item) => item.id === this.data.medicationId,
      );
      const plan = latestPlan(state, this.data.medicationId);
      if (!medication || !plan || plan.scheduleType === "as_needed")
        throw new Error("请先设置固定服药计划");
      const stale = state.calendarExports.filter(
        (item) => item.medicationId === medication.id && item.staleAt,
      );
      const oldTitles = [...new Set(stale.map((item) => item.eventTitle))]
        .map((title) => `“${title}”`)
        .join("、");
      const modal = await wx.showModal({
        title: stale.length ? "先处理旧提醒" : "写入手机日历",
        content: stale.length
          ? `旧日历事件不会自动更新。请先在系统日历中删除${oldTitles}的旧事件，再继续。确认已经处理了吗？`
          : "将按中国北京时间（UTC+8）创建最长90天的重复提醒。已写入的事件需要在手机日历中手动修改或删除。",
        cancelText: "取消",
        confirmText: stale.length ? "我已处理" : "继续",
        confirmColor: "#167A50",
      });
      if (!modal.confirm) return;
      const result = await writePlanToCalendar({
        medication,
        plan,
        showDetails: state.settings.notificationPrivacy === "detailed",
        knownFingerprints: state.calendarExports
          .filter((item) => !item.staleAt)
          .map((item) => item.fingerprint),
        onEventWritten: async (event) => {
          await getApp<IAppOption>().getService().saveCalendarExport({
            medicationId: medication.id,
            planId: plan.id,
            fingerprint: event.key,
            eventTitle: event.eventTitle,
          });
        },
      });
      if (result.reason === "denied") {
        await this.loadData();
        const permission = await wx.showModal({
          title: "需要日历权限",
          content:
            result.permissionTarget === "system"
              ? "手机系统尚未允许微信访问日历。请前往系统中的微信授权管理页开启日历权限，然后返回重试。"
              : "日历权限尚未开启。请前往授权设置，允许添加日历后返回重试；已成功写入的提醒不会重复添加。",
          confirmText: "去设置",
          cancelText: "稍后",
          confirmColor: "#167A50",
        });
        if (permission.confirm) await openCalendarPermissionSettings();
        return;
      }
      if (result.reason === "unsupported") {
        if (result.status === "partial") await this.loadData();
        await wx.showModal({
          title:
            result.status === "partial"
              ? "部分日历提醒已添加"
              : "当前环境不支持添加日历",
          content:
            result.status === "partial"
              ? "部分时间已成功添加，其余时间在当前环境不受支持。请检查手机日历并更新微信后再试；已添加的提醒不会重复写入。"
              : "请在已安装日历的手机上使用最新版微信重试；开发者工具和部分设备不能添加系统日程。药盒和服药计划已保留。",
          showCancel: false,
          confirmText: "知道了",
        });
        return;
      }
      if (result.status === "ended")
        throw new Error("计划已经结束，请先核对计划日期");
      if (
        !result.success &&
        result.status !== "noop" &&
        result.status !== "partial"
      ) {
        throw new Error("手机日历没有添加成功，请检查日历权限后重试");
      }
      await this.loadData();
      void wx.showToast({
        title:
          result.status === "partial"
            ? result.reason === "tracking-failed"
              ? "日历已添加，记录待重试同步"
              : "部分提醒已写入，可稍后重试"
            : result.status === "noop"
              ? "当前计划已经添加过"
              : "已写入手机日历",
        icon: result.status === "partial" ? "none" : "success",
      });
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ busy: false });
    }
  },

  onPhotoLoad() {
    if (this.data.photoLoadAttemptId)
      recordPhotoEvent({
        attemptId: this.data.photoLoadAttemptId,
        stage: "image_load",
        outcome: "success",
        startedAtMs: this.data.photoLoadStartedAtMs,
      });
  },

  onPhotoLoadError() {
    if (this.data.photoLoadAttemptId)
      recordPhotoEvent({
        attemptId: this.data.photoLoadAttemptId,
        stage: "image_load",
        outcome: "failure",
        startedAtMs: this.data.photoLoadStartedAtMs,
        errorCategory: "image_load_failed",
      });
    const view = this.data.view;
    if (view && view.photoUrl !== view.photoFullUrl)
      this.setData({ view: { ...view, photoUrl: view.photoFullUrl } });
  },

  previewPhoto() {
    const url = this.data.view?.photoFullUrl || this.data.view?.photoUrl;
    if (url)
      void wx
        .previewImage({ current: url, urls: [url] })
        .catch((error) => showError(error, "照片暂时无法打开，请重试"));
  },

  recordExtra() {
    const view = this.data.view;
    if (!view?.recordLabel || this.data.busy) return;
    if (!view.canTrackQuantity) {
      this.edit();
      return;
    }
    this.setData({
      recordOpen: true,
      recordQuantity: view.defaultDose,
      today: todayKey(),
      recordDate: todayKey(),
      recordTime: timeKeyFromMs(Date.now()),
      recordError: "",
      recordRequestId: createRequestId(),
    });
  },
  closeRecord() {
    if (!this.data.busy) this.setData({ recordOpen: false });
  },
  noop() {},
  onRecordQuantity(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({
      recordQuantity: e.detail.value,
      recordRequestId: createRequestId(),
    });
  },
  onRecordDate(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({
      recordDate: e.detail.value,
      recordRequestId: createRequestId(),
    });
  },
  onRecordTime(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({
      recordTime: e.detail.value,
      recordRequestId: createRequestId(),
    });
  },
  async saveUsage() {
    if (this.data.busy || !this.data.view || !this.data.recordOpen) return;
    const quantity = this.data.recordQuantity.trim();
    if (
      !/^\d+(?:\.\d{1,3})?$/.test(quantity) ||
      Number(quantity) <= 0 ||
      Number(quantity) > 1000000
    ) {
      this.setData({ recordError: "请输入大于 0、最多三位小数的数量" });
      return;
    }
    if (
      !isValidDateKey(this.data.recordDate) ||
      !isValidTimeKey(this.data.recordTime)
    ) {
      this.setData({ recordError: "请选择有效的使用日期和时间" });
      return;
    }
    const occurredAt = localDateTimeToIso(
      this.data.recordDate,
      this.data.recordTime,
    );
    if (Date.parse(occurredAt) > Date.now()) {
      this.setData({ recordError: "使用时间不能晚于现在" });
      return;
    }
    this.setData({ busy: true, recordError: "" });
    try {
      await getApp<IAppOption>()
        .getService()
        .recordIntake({
          medicationId: this.data.medicationId,
          planId: null,
          occurrenceKey: null,
          scheduledAt: null,
          status: "extra",
          quantityMilli: Math.round(Number(quantity) * 1000),
          occurredAt,
          requestId: this.data.recordRequestId,
        });
      this.setData({ recordOpen: false });
      await this.loadData();
      void wx.showToast({ title: "已记录，可在下方撤销", icon: "none" });
    } catch (error) {
      this.setData({
        recordError:
          error instanceof Error ? error.message : "保存失败，请重试",
      });
    } finally {
      this.setData({ busy: false });
    }
  },
  async undoUsage(e: WechatMiniprogram.BaseEvent) {
    if (this.data.busy) return;
    const id = String(e.currentTarget.dataset["id"] ?? "");
    const log = this.data.view?.recentUsage.find((item) => item.id === id);
    if (!log || !(await confirm("撤销这次使用？", log.text, "撤销"))) return;
    this.setData({ busy: true });
    try {
      await getApp<IAppOption>().getService().undoIntake(log.id, log.version);
      await this.loadData();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ busy: false });
    }
  },

  async archive() {
    if (this.data.busy) return;
    const shouldArchive = await confirm(
      "移除这个药盒？",
      "移除后停止服药计划和微信提醒，历史记录会保留，可在药箱的“已移除药盒”中恢复。手机日历中的旧提醒需要你自行删除。",
      "移除",
    );
    if (!shouldArchive) return;
    this.setData({ busy: true });
    try {
      await getApp<IAppOption>()
        .getService()
        .archiveMedication(this.data.medicationId, this.data.medicationVersion);
      void wx.showToast({ title: "已移除", icon: "success" });
      setTimeout(() => void wx.switchTab({ url: "/pages/cabinet/index" }), 500);
    } catch (error) {
      showError(error);
      this.setData({ busy: false });
    }
  },

  async deletePermanently() {
    if (this.data.busy) return;
    const warning = await wx.showModal({
      title: "永久删除这个药盒？",
      content:
        "将删除这盒药的计划、盘点与使用记录，无法恢复。已经写入手机系统日历的事件仍需你自行删除。",
      cancelText: "取消",
      confirmText: "继续",
      confirmColor: "#B63D3D",
    });
    if (!warning.confirm) return;
    const verification = await wx.showModal({
      title: "输入“删除”确认",
      editable: true,
      placeholderText: "删除",
      cancelText: "取消",
      confirmText: "永久删除",
      confirmColor: "#B63D3D",
    });
    if (!verification.confirm) return;
    if (verification.content.trim() !== "删除") {
      void wx.showToast({ title: "请输入“删除”", icon: "none" });
      return;
    }
    this.setData({ busy: true });
    try {
      await getApp<IAppOption>()
        .getService()
        .deleteMedication(this.data.medicationId, this.data.medicationVersion);
      void wx.showToast({ title: "已永久删除", icon: "success" });
      setTimeout(() => void wx.switchTab({ url: "/pages/cabinet/index" }), 500);
    } catch (error) {
      showError(error, "没有删除成功");
      this.setData({ busy: false });
    }
  },
});
