import { saveJobView } from "../../services/save-job-view";
import { selectMedicationPhoto } from "../../services/medication-photo";
import { getIntakeQueue } from "../../services/intake-queue";
import {
  getSaveQueue,
  observeSave,
  SAVE_BUDGET_MS,
} from "../../services/save-queue";
import { showError } from "../../services/ui";

Page({
  data: {
    jobs: [] as Array<{
      id: string;
      name: string;
      message: string;
      medicationId: string;
      canDiscard: boolean;
      canReselect: boolean;
      terminal: boolean;
    }>,
    intakes: [] as Array<{
      id: string;
      name: string;
      message: string;
      terminal: boolean;
    }>,
    busy: "",
    error: "",
  },
  unsubscribe: null as (() => void) | null,
  unsubscribeIntakes: null as (() => void) | null,
  async onShow() {
    const service = getApp<IAppOption>().getService();
    this.unsubscribe?.();
    this.unsubscribeIntakes?.();
    this.unsubscribeIntakes = getIntakeQueue(service).subscribe(() =>
      this.refresh(),
    );
    this.unsubscribe = getSaveQueue(service).subscribe(() => this.refresh());
    this.refresh();
    try {
      await service.bootstrap();
      this.refresh();
    } catch {
      this.setData({ error: "当前无法连接，已保留本机待同步任务" });
    }
  },
  onHide() {
    this.unsubscribeIntakes?.();
    this.unsubscribe?.();
    this.unsubscribe = null;
  },
  onUnload() {
    this.unsubscribeIntakes?.();
    this.unsubscribe?.();
  },
  refresh() {
    this.setData({
      intakes: getIntakeQueue(getApp<IAppOption>().getService())
        .list()
        .filter((item) => item.status !== "synced")
        .map((item) => ({
          id: item.id,
          name: item.name,
          message: item.message,
          terminal: item.terminal,
        })),
    });
    this.setData({
      jobs: getSaveQueue(getApp<IAppOption>().getService())
        .list()
        .filter((job) => job.status !== "ready")
        .map((job) => ({
          id: job.id,
          name: job.draft.name,
          message: saveJobView(job).message,
          medicationId: job.medicationId ?? job.draft.id ?? "",
          canDiscard: saveJobView(job).canDiscard,
          canReselect: saveJobView(job).canReselect,
          terminal: job.terminal,
        })),
    });
  },
  async retryIntake(event: WechatMiniprogram.BaseEvent) {
    if (this.data.busy) return;
    const id = String(event.currentTarget.dataset["id"] ?? "");
    this.setData({ busy: id });
    try {
      await getIntakeQueue(getApp<IAppOption>().getService()).run(id);
      this.refresh();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ busy: "" });
    }
  },
  async dismissIntake(event: WechatMiniprogram.BaseEvent) {
    const result = await wx.showModal({
      title: "已核对历史记录？",
      content: "请先确认云端记录。这只移除失败任务，不会撤销已存在的服药记录。",
      confirmText: "已核对",
    });
    if (!result.confirm) return;
    try {
      getIntakeQueue(getApp<IAppOption>().getService()).discard(
        String(event.currentTarget.dataset["id"] ?? ""),
      );
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },
  async reselectPhoto(event: WechatMiniprogram.BaseEvent) {
    if (this.data.busy) return;
    const id = String(event.currentTarget.dataset["id"] ?? "");
    this.setData({ busy: id, error: "" });
    try {
      const selected = await selectMedicationPhoto();
      if (!selected) return;
      const deadline = Date.now() + SAVE_BUDGET_MS;
      await observeSave(
        getSaveQueue(getApp<IAppOption>().getService()).reselectPhoto(
          id,
          selected.tempFilePath,
          deadline,
        ),
        deadline,
      );
      this.refresh();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ busy: "" });
    }
  },
  async retryJob(event: WechatMiniprogram.BaseEvent) {
    if (this.data.busy) return;
    const id = String(event.currentTarget.dataset["id"] ?? "");
    this.setData({ busy: id, error: "" });
    try {
      await observeSave(
        getSaveQueue(getApp<IAppOption>().getService()).run(id),
        Date.now() + SAVE_BUDGET_MS,
      );
      this.refresh();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ busy: "" });
    }
  },
  async discardJob(event: WechatMiniprogram.BaseEvent) {
    if (this.data.busy) return;
    const id = String(event.currentTarget.dataset["id"] ?? "");
    const result = await wx.showModal({
      title: "移除待同步任务？",
      content:
        "这会移除本机待同步照片。已经保存的药盒和照片保留，请到药箱核对后再编辑。",
      confirmText: "移除任务",
      cancelText: "保留",
    });
    if (!result.confirm) return;
    this.setData({ busy: id });
    try {
      await getSaveQueue(getApp<IAppOption>().getService()).discard(id);
      this.refresh();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ busy: "" });
    }
  },
  openMedicine(event: WechatMiniprogram.BaseEvent) {
    const id = String(event.currentTarget.dataset["id"] ?? "");
    if (id)
      void wx.navigateTo({ url: `/pages/medicine-detail/index?id=${id}` });
  },
});
