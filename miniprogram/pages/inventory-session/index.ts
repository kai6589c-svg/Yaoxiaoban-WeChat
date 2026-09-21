import { getInventorySession } from "../../services/inventory-session";
import { showError } from "../../services/ui";

Page({
  data: {
    loading: true,
    saving: false,
    error: "",
    index: 0,
    total: 0,
    completed: 0,
    name: "",
    unit: "",
    quantity: "",
    pending: false,
    finished: false,
  },
  onShow() {
    void this.refresh();
  },
  async refresh() {
    try {
      const service = getApp<IAppOption>().getService();
      const state = await service.bootstrap();
      const session = getInventorySession(service).load();
      const index =
        session?.steps.findIndex(
          (step) => step.status === "draft" || step.status === "pending",
        ) ?? -1;
      const step = session?.steps[index];
      const medication = state.medications.find(
        (item) => item.id === step?.medicationId,
      );
      if (medication && step)
        getInventorySession(service).bindMedication(
          index,
          medication.version,
          medication.unit,
        );
      this.setData({
        loading: false,
        error: "",
        index,
        total: session?.steps.length ?? 0,
        completed:
          session?.steps.filter((item) => item.status === "done").length ?? 0,
        finished: !step,
        name: medication?.name ?? "药盒已不可用",
        unit: step?.unit || medication?.unit || "未设置单位",
        quantity: step?.quantity ?? "",
        pending: step?.status === "pending",
      });
    } catch (error) {
      this.setData({
        loading: false,
        error: error instanceof Error ? error.message : "加载失败，请稍后重试",
      });
    }
  },
  onQuantityInput(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    try {
      getInventorySession(getApp<IAppOption>().getService()).edit(
        this.data.index,
        event.detail.value,
      );
      this.setData({ quantity: event.detail.value });
    } catch (error) {
      showError(error);
    }
  },
  async confirm() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      await getInventorySession(getApp<IAppOption>().getService()).confirm(
        this.data.index,
      );
    } catch (error) {
      showError(error, "结果尚未确认，重试会核对同一次盘点");
    } finally {
      this.setData({ saving: false });
      await this.refresh();
    }
  },
  async skip() {
    try {
      getInventorySession(getApp<IAppOption>().getService()).skip(
        this.data.index,
      );
      await this.refresh();
    } catch (error) {
      showError(error);
    }
  },
  async finish() {
    const answer = await wx.showModal({
      title: "结束本次盘点？",
      content: "已确认的盘点会保留，未提交的草稿将清除。",
    });
    if (!answer.confirm) return;
    try {
      getInventorySession(getApp<IAppOption>().getService()).clear();
      void wx.navigateBack();
    } catch (error) {
      showError(error);
    }
  },
});
