import { groupTodayTasks, taskStatusText } from "../../core/task-presentation";
import { getIntakeQueue } from "../../services/intake-queue";
import { buildTodayDashboard } from "../../core/dashboard";
import {
  dayOfWeek,
  formatDose,
  formatShortChineseDate,
  todayKey,
} from "../../core/dates";
import type { RiskItem, TodayTask } from "../../core/models";
import { createRequestId } from "../../core/id";
import { showError, withLoading } from "../../services/ui";

interface TaskView extends TodayTask {
  doseText: string;
  timeText: string;
  statusText: string;
  statusClass: string;
  canRecord: boolean;
  canSkip: boolean;
  isRecorded: boolean;
  needsExpiryReview: boolean;
  heroLabel: string;
  availabilityText: string;
}

interface RiskView extends RiskItem {
  levelText: string;
}

const weekdayNames = [
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
  "星期日",
];

const mapTask = (task: TodayTask, nowMs: number): TaskView => {
  const statusMap: Record<
    TodayTask["status"],
    { text: string; className: string }
  > = {
    upcoming: { text: `今天 ${task.time}`, className: "upcoming" },
    due: { text: "按计划已计入预计用量", className: "due" },
    taken: { text: "已记录服用", className: "taken" },
    skipped: { text: "已记未服", className: "skipped" },
    "needs-review": {
      text: "管理期限已过，请先核对药盒",
      className: "review",
    },
  };
  const status = statusMap[task.status];
  const canRecordNow =
    task.status === "due" ||
    (task.status === "upcoming" && task.scheduledAtMs - nowMs <= 10 * 60_000);
  return {
    ...task,
    doseText: formatDose(task.doseMilli, task.unit),
    timeText: task.time,
    statusText: taskStatusText(task),
    statusClass: status.className,
    canRecord: canRecordNow,
    canSkip: task.status === "due",
    isRecorded: task.status === "taken" || task.status === "skipped",
    needsExpiryReview: task.status === "needs-review",
    heroLabel: task.status === "due" ? "现在需要处理" : "下一次",
    availabilityText: canRecordNow
      ? "现在可以记录"
      : `到 ${task.time} 前10分钟可记录`,
  };
};

Page({
  data: {
    loading: true,
    error: "",
    dateText: "",
    allTasks: [] as TaskView[],
    pendingTasks: [] as TaskView[],
    recordedTasks: [] as TaskView[],
    risks: [] as RiskView[],
    hasMedicine: false,
    multipleProfiles: false,
    quietActionText: "查看药箱",
    quietActionHint: "今天无需操作，药箱仍会留意有效期和预计余量。",
    quietActionMedicationId: "",
    quietActionRoute: "cabinet" as "cabinet" | "detail" | "edit",
    busyKey: "",
    syncNotice: "",
  },

  openPendingSaves() {
    void wx.navigateTo({ url: "/pages/sync/index" });
  },

  applyPendingRecords() {
    const jobs = getIntakeQueue(getApp<IAppOption>().getService())
      .list()
      .filter((job) => job.status !== "synced");
    const tasks = this.data.allTasks.map((task) => {
      const pending = jobs.find((job) => job.input.occurrenceKey === task.key);
      return pending
        ? {
            ...task,
            canRecord: false,
            canSkip: false,
            isRecorded: true,
            statusText: pending.terminal
              ? "同步未完成，请处理"
              : "已记录，待同步",
            statusClass: "pending-sync",
            availabilityText: "待同步",
            logId: null,
          }
        : task;
    });
    this.setData({
      allTasks: groupTodayTasks(tasks),
      pendingTasks: tasks.filter(
        (task) => !task.isRecorded && !task.needsExpiryReview,
      ),
      recordedTasks: tasks.filter((task) => task.isRecorded),
      syncNotice: jobs.length
        ? `${jobs.length} 条记录待同步；预计余量以云端确认结果为准`
        : "",
    });
  },

  async onShow() {
    this.getTabBar?.()?.setData({ selected: 0 });
    await this.loadData();
  },

  async onPullDownRefresh() {
    await this.loadData();
    void wx.stopPullDownRefresh();
  },

  async loadData() {
    this.setData({ loading: true, error: "" });
    try {
      const service = getApp<IAppOption>().getService();
      const board = service.getTodayDashboard
        ? await service.getTodayDashboard()
        : buildTodayDashboard(await service.bootstrap());
      if (!board.privacyAcceptedVersion) {
        await wx.reLaunch({ url: "/pages/start/index" });
        return;
      }
      const now = Date.now();
      const tasks = board.tasks.map((task) => mapTask(task, now));
      const risks = board.risks.map((risk) => ({
        ...risk,
        levelText:
          risk.level === "danger"
            ? "需要处理"
            : risk.level === "warning"
              ? "请留意"
              : "提醒",
      }));
      const expiredRisk = risks.find((risk) => risk.type === "expired");
      const planlessMedicationId = board.summary.planlessMedicationId;
      let quietActionText = "查看药箱";
      let quietActionHint = "今天无需操作，药箱仍会留意有效期和预计余量。";
      let quietActionMedicationId = "";
      let quietActionRoute: "cabinet" | "detail" | "edit" = "cabinet";
      if (expiredRisk) {
        quietActionText = "处理已到期药盒";
        quietActionHint = "这盒药已超过管理期限，请先核对、更新或移除。";
        quietActionMedicationId = expiredRisk.medicationId;
        quietActionRoute = "detail";
      } else if (planlessMedicationId) {
        quietActionText = "为已有药盒设置计划";
        quietActionHint = "已有药盒还没有服药计划；也可以继续只管理有效期。";
        quietActionMedicationId = planlessMedicationId;
        quietActionRoute = "edit";
      }
      const today = todayKey(now);
      this.setData({
        loading: false,
        dateText: `${formatShortChineseDate(today)} · ${weekdayNames[dayOfWeek(today) - 1]}`,
        allTasks: groupTodayTasks(tasks),
        pendingTasks: tasks.filter(
          (task) => !task.isRecorded && !task.needsExpiryReview,
        ),
        recordedTasks: tasks.filter((task) => task.isRecorded),
        risks,
        hasMedicine: board.summary.medicationCount > 0,
        multipleProfiles: board.summary.multipleProfiles,
        quietActionText,
        quietActionHint,
        quietActionMedicationId,
        quietActionRoute,
      });
      this.applyPendingRecords();
    } catch (error) {
      if (this.data.allTasks.length) {
        this.setData({ loading: false, error: "" });
        this.applyPendingRecords();
        this.setData({
          syncNotice:
            "当前无法连接，显示上次加载的计划。待同步记录已保存在本机。",
        });
        return;
      }
      this.setData({
        loading: false,
        error: error instanceof Error ? error.message : "暂时没加载出来",
      });
    }
  },

  async recordTask(event: WechatMiniprogram.BaseEvent) {
    const key = String(event.currentTarget.dataset["key"] ?? "");
    const status = String(event.currentTarget.dataset["status"] ?? "") as
      "taken" | "skipped";
    const task = this.data.allTasks.find((item) => item.key === key);
    if (!task || this.data.busyKey) return;
    this.setData({ busyKey: key });
    try {
      const service = getApp<IAppOption>().getService();
      if (service.supportsDurableSaves) {
        const queue = getIntakeQueue(service);
        const job = queue.enqueue(task, status);
        this.applyPendingRecords();
        void queue
          .run(job.id)
          .then(() => this.loadData())
          .catch(() => undefined);
        void wx.showToast({ title: "已记录，待同步", icon: "none" });
        return;
      }
      await service.recordIntake({
        medicationId: task.medicationId,
        planId: task.planId,
        occurrenceKey: task.key,
        scheduledAt: task.scheduledAt,
        status,
        quantityMilli: task.doseMilli,
        requestId: createRequestId(),
      });
      await this.loadData();
      void wx.showToast({
        title: status === "taken" ? "已记录服用" : "已记未服",
        icon: "success",
      });
    } catch (error) {
      showError(error, "没有保存成功，请重试");
    } finally {
      this.setData({ busyKey: "" });
    }
  },

  async undoTask(event: WechatMiniprogram.BaseEvent) {
    const logId = String(event.currentTarget.dataset["logId"] ?? "");
    if (!logId || this.data.busyKey) return;
    this.setData({ busyKey: logId });
    try {
      const state = await getApp<IAppOption>().getService().bootstrap();
      const log = state.intakeLogs.find((item) => item.id === logId);
      if (!log) throw new Error("记录不存在");
      await getApp<IAppOption>().getService().undoIntake(log.id, log.version);
      await this.loadData();
      void wx.showToast({ title: "已撤销", icon: "success" });
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ busyKey: "" });
    }
  },

  openRisk(event: WechatMiniprogram.BaseEvent) {
    const medicationId = String(
      event.currentTarget.dataset["medicationId"] ?? "",
    );
    const type = String(event.currentTarget.dataset["type"] ?? "");
    if (type === "low-stock" || type === "unknown-stock") {
      void wx.navigateTo({ url: `/pages/inventory/index?id=${medicationId}` });
      return;
    }
    void wx.navigateTo({
      url: `/pages/medicine-detail/index?id=${medicationId}`,
    });
  },

  addMedicine() {
    void wx.navigateTo({ url: "/pages/medicine-form/index" });
  },

  openQuietAction() {
    if (
      this.data.quietActionRoute === "detail" &&
      this.data.quietActionMedicationId
    ) {
      void wx.navigateTo({
        url: `/pages/medicine-detail/index?id=${this.data.quietActionMedicationId}`,
      });
      return;
    }
    if (
      this.data.quietActionRoute === "edit" &&
      this.data.quietActionMedicationId
    ) {
      void wx.navigateTo({
        url: `/pages/medicine-form/index?id=${this.data.quietActionMedicationId}`,
      });
      return;
    }
    void wx.switchTab({ url: "/pages/cabinet/index" });
  },

  openSettings() {
    void wx.navigateTo({ url: "/pages/settings/index" });
  },

  openHistory() {
    void wx.navigateTo({ url: "/pages/history/index" });
  },

  openTaskMedicine(event: WechatMiniprogram.BaseEvent) {
    const medicationId = String(
      event.currentTarget.dataset["medicationId"] ?? "",
    );
    if (!medicationId) return;
    void wx.navigateTo({
      url: `/pages/medicine-detail/index?id=${medicationId}`,
    });
  },

  async retry() {
    await withLoading("重新加载", () => this.loadData());
  },
});
