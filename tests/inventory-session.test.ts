import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InventorySessionStore } from "../miniprogram/services/inventory-session";
import type { DataService } from "../miniprogram/services/data-service";
import { appState } from "./fixtures";
const storage = new Map<string, unknown>();
let service: DataService;
let bootstrapMock = vi.fn<DataService["bootstrap"]>();
let confirmMock = vi.fn<DataService["confirmInventory"]>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("wx", {
    getStorageSync: (key: string) => structuredClone(storage.get(key)),
    setStorageSync: (key: string, value: unknown) =>
      storage.set(key, structuredClone(value)),
    removeStorageSync: (key: string) => storage.delete(key),
  });
  bootstrapMock = vi
    .fn<DataService["bootstrap"]>()
    .mockResolvedValue(appState());
  confirmMock = vi
    .fn<DataService["confirmInventory"]>()
    .mockResolvedValue(appState());
  service = {
    supportsDurableSaves: true,
    syncScope: "a",
    bootstrap: bootstrapMock,
    confirmInventory: confirmMock,
  } as unknown as DataService;
});
afterEach(() => vi.unstubAllGlobals());
it("persists a fixed payload before dispatch and retries it after restart", async () => {
  const store = new InventorySessionStore(service);
  store.start(["med-1"]);
  store.edit(0, "1.25");
  confirmMock.mockRejectedValueOnce(new Error("lost response"));
  await expect(store.confirm(0)).rejects.toThrow("lost response");
  expect(store.load()?.steps[0]?.status).toBe("pending");
  expect(() => store.edit(0, "5")).toThrow();
  expect(() => store.skip(0)).toThrow();
  expect(() => store.clear()).toThrow();
  const recovered = new InventorySessionStore(service);
  await recovered.confirm(0);
  expect(confirmMock.mock.calls[0]).toEqual(confirmMock.mock.calls[1]);
  expect(recovered.load()?.steps[0]?.status).toBe("done");
  await recovered.confirm(0);
  expect(confirmMock).toHaveBeenCalledTimes(2);
});
it("offline preflight preserves only a draft and never sends a write", async () => {
  const store = new InventorySessionStore(service);
  store.start(["med-1"]);
  store.edit(0, "0");
  bootstrapMock.mockRejectedValueOnce(new Error("offline"));
  await expect(store.confirm(0)).rejects.toThrow("offline");
  expect(store.load()?.steps[0]?.status).toBe("draft");
  expect(confirmMock).not.toHaveBeenCalled();
});
it("isolates accounts and rejects account changes during preflight", async () => {
  const store = new InventorySessionStore(service);
  store.start(["med-1"]);
  store.edit(0, "2");
  bootstrapMock.mockImplementation(async () => {
    service.syncScope = "b";
    return appState();
  });
  await expect(store.confirm(0)).rejects.toThrow("账号已变化");
  expect(confirmMock).not.toHaveBeenCalled();
  expect(new InventorySessionStore(service).load()).toBeNull();
});
it("rejects blank, excess precision, removed and unitless boxes without writing", async () => {
  const store = new InventorySessionStore(service);
  store.start(["med-1"]);
  await expect(store.confirm(0)).rejects.toThrow("数量");
  store.edit(0, "0.0001");
  await expect(store.confirm(0)).rejects.toThrow("数量");
  store.edit(0, "1");
  const state = appState();
  state.medications[0]!.archivedAt = new Date().toISOString();
  bootstrapMock.mockResolvedValue(state);
  await expect(store.confirm(0)).rejects.toThrow("已移除");
  expect(confirmMock).not.toHaveBeenCalled();
});
it("storage failure prevents the write; skipped entries never mutate inventory", async () => {
  const store = new InventorySessionStore(service);
  store.start(["med-1"]);
  store.edit(0, "3");
  const spy = vi.spyOn(wx, "setStorageSync").mockImplementationOnce(() => {
    throw new Error("quota");
  });
  await expect(store.confirm(0)).rejects.toThrow("quota");
  spy.mockRestore();
  expect(confirmMock).not.toHaveBeenCalled();
  store.skip(0);
  store.clear();
  expect(store.load()).toBeNull();
});

it("a changed box version stops before sending a snapshot", async () => {
  const store = new InventorySessionStore(service);
  store.start(["med-1"]);
  store.bindMedication(0, 1, "片");
  store.edit(0, "1.001");
  const state = appState();
  state.medications[0]!.version = 2;
  bootstrapMock.mockResolvedValue(state);
  await expect(store.confirm(0)).rejects.toThrow("已变化");
  expect(confirmMock).not.toHaveBeenCalled();
  expect(store.load()?.steps[0]?.status).toBe("draft");
});
it("three-decimal quantities survive floating-point rounding", async () => {
  const store = new InventorySessionStore(service);
  store.start(["med-1"]);
  store.edit(0, "1.001");
  await store.confirm(0);
  expect(confirmMock.mock.calls[0]?.[0].quantityMilli).toBe(1001);
});
