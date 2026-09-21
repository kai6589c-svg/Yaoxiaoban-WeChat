import { createRequestId } from "../core/id";
import { ServiceError, type DataService } from "./data-service";

export interface InventoryStep {
  medicationId: string;
  quantity: string;
  status: "draft" | "pending" | "done" | "skipped";
  expectedVersion?: number;
  unit?: string;
  requestId?: string;
  recordedAt?: string;
}
export interface InventorySession {
  id: string;
  steps: InventoryStep[];
}
const scopeOf = (service: DataService): string => {
  const scope = service.supportsDurableSaves ? service.syncScope : "local-demo";
  if (!scope) throw new Error("请先加载药箱，确认当前账号");
  return scope;
};
export class InventorySessionStore {
  private readonly scope: string;
  private readonly key: string;
  private busy = false;
  constructor(private readonly service: DataService) {
    this.scope = scopeOf(service);
    this.key = `yaoxiaoban_inventory_session:${this.scope}`;
  }
  private check() {
    if (scopeOf(this.service) !== this.scope)
      throw new Error("账号已变化，请重新打开盘点");
  }
  load(): InventorySession | null {
    this.check();
    const value = wx.getStorageSync(this.key) as InventorySession | undefined;
    if (!value || !Array.isArray(value.steps)) return null;
    return JSON.parse(JSON.stringify(value)) as InventorySession;
  }
  private persist(session: InventorySession) {
    this.check();
    wx.setStorageSync(this.key, session);
  }
  start(ids: string[]) {
    if (this.load()) throw new Error("请先完成或结束现有盘点");
    if (!ids.length) throw new Error("当前筛选没有可盘点药盒");
    this.persist({
      id: createRequestId(),
      steps: [...new Set(ids)].map((medicationId) => ({
        medicationId,
        quantity: "",
        status: "draft",
      })),
    });
  }
  bindMedication(index: number, version: number, unit: string) {
    const session = this.load();
    const step = session?.steps[index];
    if (
      session &&
      step &&
      step.status === "draft" &&
      step.expectedVersion === undefined
    ) {
      step.expectedVersion = version;
      step.unit = unit;
      this.persist(session);
    }
  }
  edit(index: number, quantity: string) {
    if (this.busy) throw new Error("正在核对，请稍后修改");
    const session = this.load();
    const step = session?.steps[index];
    if (!session || !step || step.status !== "draft")
      throw new Error("该项已提交，不能修改待核对的数量");
    step.quantity = quantity;
    this.persist(session);
  }
  skip(index: number) {
    if (this.busy) throw new Error("正在核对，请稍后跳过");
    const session = this.load();
    const step = session?.steps[index];
    if (!session || !step || step.status !== "draft")
      throw new Error("请先核对待确认的盘点结果");
    step.status = "skipped";
    this.persist(session);
  }
  clear() {
    const session = this.load();
    if (this.busy || session?.steps.some((step) => step.status === "pending"))
      throw new Error("仍有待确认结果，请先重试核对");
    wx.removeStorageSync(this.key);
  }
  async confirm(index: number) {
    if (this.busy) return;
    this.busy = true;
    try {
      const session = this.load();
      const step = session?.steps[index];
      if (
        !session ||
        !step ||
        step.status === "done" ||
        step.status === "skipped"
      )
        return;
      const quantityMilli = Math.round(Number(step.quantity) * 1000);
      if (
        !/^\d+(?:\.\d{1,3})?$/.test(step.quantity.trim()) ||
        !Number.isSafeInteger(quantityMilli) ||
        quantityMilli < 0
      )
        throw new Error("请输入最多三位小数的非负数量");
      if (step.status === "draft") {
        const state = await this.service.bootstrap();
        this.check();
        const medication = state.medications.find(
          (item) => item.id === step.medicationId && !item.archivedAt,
        );
        if (!medication?.unit)
          throw new Error("药盒已移除或尚未设置数量单位，请返回编辑");
        if (
          step.expectedVersion !== undefined &&
          (step.expectedVersion !== medication.version ||
            step.unit !== medication.unit)
        )
          throw new Error("药盒信息已变化，请跳过此盒，核对后重新盘点");
        step.requestId = createRequestId();
        step.recordedAt = new Date().toISOString();
        step.status = "pending";
        this.persist(session);
      }
      try {
        await this.service.confirmInventory({
          medicationId: step.medicationId,
          quantityMilli,
          requestId: step.requestId,
          recordedAt: step.recordedAt,
          note: "集中盘点",
        });
      } catch (error) {
        if (
          error instanceof ServiceError &&
          [
            "INVALID_ARGUMENT",
            "VALIDATION",
            "NOT_FOUND",
            "MEDICATION_ARCHIVED",
          ].includes(error.code) &&
          error.outcome === "definite"
        ) {
          if (this.load()?.id === session.id) {
            step.status = "draft";
            step.requestId = undefined;
            step.recordedAt = undefined;
            this.persist(session);
          }
        }
        throw error;
      }
      this.check();
      if (this.load()?.id !== session.id)
        throw new Error("盘点已结束，请重新加载");
      step.status = "done";
      this.persist(session);
    } finally {
      this.busy = false;
    }
  }
}
const stores = new WeakMap<DataService, InventorySessionStore>();
export const getInventorySession = (
  service: DataService,
): InventorySessionStore => {
  const cached = stores.get(service);
  if (cached) {
    try {
      cached.load();
      return cached;
    } catch {
      stores.delete(service);
    }
  }
  const store = new InventorySessionStore(service);
  stores.set(service, store);
  return store;
};

export const clearInventorySession = (service: DataService): void => {
  wx.removeStorageSync(`yaoxiaoban_inventory_session:${scopeOf(service)}`);
  stores.delete(service);
};
