import {
  dateKeyFromMs,
  formatDose,
  formatLocalDateTime,
} from "../../core/dates";
import { showError } from "../../services/ui";

interface LogView {
  dateKey: string;
  profileId: string;
  id: string;
  title: string;
  detail: string;
  time: string;
  scheduledTime: string;
  version: number;
  statusClass: "taken" | "skipped" | "extra";
  iconPath: string;
}

Page({
  data: {
    loading: true,
    error: "",
    medicationId: "",
    logs: [] as LogView[],
    allLogs: [] as LogView[],
    profiles: [{ id: "all", name: "全部成员" }],
    profileIndex: 0,
    fromDate: "",
    toDate: "",
    filterError: "",
    matchedCount: 0,
    visibleLimit: 50,

    busyId: "",
  },

  onLoad(options: Record<string, string | undefined>) {
    this.setData({ medicationId: options["id"] ?? "" });
  },

  async onShow() {
    await this.loadData();
  },

  async loadData() {
    this.setData({ loading: true, error: "" });
    try {
      const state = await getApp<IAppOption>().getService().bootstrap();
      const medicationMap = new Map(
        state.medications.map((item) => [item.id, item]),
      );
      const statusText = {
        taken: "已记录服用",
        skipped: "已记未服",
        extra: "额外使用",
      } as const;
      const logs = state.intakeLogs
        .filter(
          (item) =>
            !item.voidedAt &&
            (!this.data.medicationId ||
              item.medicationId === this.data.medicationId),
        )
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
        .flatMap((log): LogView[] => {
          const medication = medicationMap.get(log.medicationId);
          if (!medication) return [];
          return [
            {
              id: log.id,
              dateKey: dateKeyFromMs(Date.parse(log.occurredAt)),
              profileId: medication.profileId,
              title: `${medication.name} · ${statusText[log.status]}`,
              detail: `${state.profiles.find((item) => item.id === medication.profileId)?.name ?? "成员"} · ${formatDose(log.quantityMilli, medication.unit)}`,
              time: formatLocalDateTime(log.occurredAt),
              scheduledTime: log.scheduledAt
                ? formatLocalDateTime(log.scheduledAt)
                : "",
              version: log.version,
              statusClass: log.status,
              iconPath:
                log.status === "extra"
                  ? "/assets/ui/star.png"
                  : log.status === "skipped"
                    ? "/assets/ui/x.png"
                    : "/assets/ui/check.png",
            },
          ];
        });
      this.setData({
        loading: false,
        allLogs: logs,
        profiles: [
          { id: "all", name: "全部成员" },
          ...state.profiles.map(({ id, name }) => ({ id, name })),
        ],
      });
      this.applyFilters();
    } catch (error) {
      showError(error);
      this.setData({
        loading: false,
        error: error instanceof Error ? error.message : "没有加载成功",
      });
    }
  },

  applyFilters() {
    const { fromDate, toDate, allLogs, visibleLimit } = this.data;
    const profileId = this.data.profiles[this.data.profileIndex]?.id ?? "all";
    const filterError =
      fromDate && toDate && fromDate > toDate ? "开始日期不能晚于结束日期" : "";
    const matches = filterError
      ? []
      : allLogs.filter(
          (item) =>
            (profileId === "all" || item.profileId === profileId) &&
            (!fromDate || item.dateKey >= fromDate) &&
            (!toDate || item.dateKey <= toDate),
        );
    this.setData({
      filterError,
      matchedCount: matches.length,
      logs: matches.slice(0, visibleLimit),
    });
  },
  changeProfile(event: WechatMiniprogram.PickerChange) {
    this.setData({
      profileIndex: Number(event.detail.value),
      visibleLimit: 50,
    });
    this.applyFilters();
  },
  changeFrom(event: WechatMiniprogram.PickerChange) {
    this.setData({ fromDate: String(event.detail.value), visibleLimit: 50 });
    this.applyFilters();
  },
  changeTo(event: WechatMiniprogram.PickerChange) {
    this.setData({ toDate: String(event.detail.value), visibleLimit: 50 });
    this.applyFilters();
  },
  clearFilters() {
    this.setData({
      fromDate: "",
      toDate: "",
      profileIndex: 0,
      visibleLimit: 50,
    });
    this.applyFilters();
  },
  loadMore() {
    this.setData({ visibleLimit: this.data.visibleLimit + 50 });
    this.applyFilters();
  },
  onReachBottom() {
    if (this.data.logs.length < this.data.matchedCount) this.loadMore();
  },
  retry() {
    void this.loadData();
  },

  async undo(event: WechatMiniprogram.BaseEvent) {
    const id = String(event.currentTarget.dataset["id"] ?? "");
    const version = Number(event.currentTarget.dataset["version"]);
    if (!id || this.data.busyId) return;
    const modal = await wx.showModal({
      title: "撤销这条记录？",
      content: "撤销后，预计余量会按原计划重新计算。",
      confirmText: "撤销",
      confirmColor: "#167A50",
    });
    if (!modal.confirm) return;
    this.setData({ busyId: id });
    try {
      await getApp<IAppOption>().getService().undoIntake(id, version);
      await this.loadData();
      void wx.showToast({ title: "已撤销", icon: "success" });
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ busyId: "" });
    }
  },
});
