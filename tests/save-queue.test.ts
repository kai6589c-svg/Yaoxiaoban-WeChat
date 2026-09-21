import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createDataService,
  ServiceError,
  type DataService,
} from "../miniprogram/services/data-service";
import { SaveQueue, observeSave } from "../miniprogram/services/save-queue";
import type { MedicationDraft } from "../miniprogram/core/models";
import { appState, medication } from "./fixtures";

const storage = new Map<string, unknown>();
const files = new Set<string>();
const calls: Array<{
  action: string;
  requestId: string;
  payload: Record<string, unknown>;
}> = [];
let handler: (data: (typeof calls)[number]) => Promise<unknown>;
let service: DataService;
const draft: MedicationDraft = {
  profileId: "profile-1",
  name: "测试",
  specification: "",
  unit: "",
  mode: "expiry_only",
  expiryPrecision: "day",
  expiryValue: "2027-09-10",
  openedDate: null,
  afterOpenDays: null,
  note: "",
  initialQuantityMilli: null,
  schedule: null,
};
const saved = medication({ id: "med-new", version: 1 });
const bootstrap = { ...appState(), syncScope: "account-A" };
const ok = (data: unknown) => Promise.resolve({ result: { ok: true, data } });
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T03:00:00Z"));
  storage.clear();
  files.clear();
  calls.length = 0;
  handler = (data) => {
    if (data.action === "bootstrap") return ok(bootstrap);
    if (data.action === "saveMedicationFast")
      return ok({ medication: saved, planId: null });
    if (data.action === "prepareMedicationPhoto")
      return ok({
        mediaId: "media-new",
        cloudPath: "medication-photos/test.jpg",
        maxBytes: 2097152,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        transport: "cloud",
        protocol: "chunks-v2",
      });
    if (data.action === "putMedicationPhotoChunk")
      return ok({ accepted: true });
    if (data.action === "completeMedicationPhotoUpload")
      return ok({
        ...saved,
        version: 2,
        photo: {
          mediaId: "media-new",
          url: "https://fixture.test/photo",
          updatedAt: new Date().toISOString(),
        },
      });
    if (data.action === "getMedicationPhotoStatus")
      return ok({
        status: "attached",
        mediaId: "media-new",
        medicationId: "med-new",
      });
    return ok(null);
  };
  vi.stubGlobal("wx", {
    env: { USER_DATA_PATH: "/data" },
    getStorageSync: (key: string) => structuredClone(storage.get(key)),
    setStorageSync: (key: string, value: unknown) =>
      storage.set(key, structuredClone(value)),
    removeStorageSync: (key: string) => storage.delete(key),
    cloud: {
      callFunction: ({ data }: { data: (typeof calls)[number] }) => {
        calls.push(data);
        return handler(data);
      },
      uploadFile: vi.fn(() => {
        throw new Error("v2 must not use native upload");
      }),
    },
    getFileSystemManager: () => ({
      accessSync: (path: string) => {
        if (!files.has(path)) throw new Error("missing");
      },
      copyFileSync: (_src: string, dst: string) => files.add(dst),
      unlinkSync: (path: string) => files.delete(path),
      getFileInfo: (args: { success: (value: { size: number }) => void }) =>
        args.success({ size: 6 }),
      readFile: (args: { success: (value: { data: string }) => void }) =>
        args.success({ data: "aW1hZ2U=" }),
    }),
  });
  service = createDataService("cloud");
  await service.bootstrap();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("persists image before sending, binds via compact pipeline once, and clears local file only after confirmation", async () => {
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/photo.jpg", "replace");
  expect(files.has(job.filePath)).toBe(true);
  expect(
    calls.filter((call) => call.action === "saveMedicationFast"),
  ).toHaveLength(0);
  const one = queue.run(job.id),
    two = queue.run(job.id);
  expect(one).toBe(two);
  expect((await one).status).toBe("ready");
  expect(files.size).toBe(0);
  expect(
    calls.filter((call) => call.action === "saveMedicationFast"),
  ).toHaveLength(1);
  expect(
    calls.filter((call) => call.action === "completeMedicationPhotoUpload"),
  ).toHaveLength(1);
  expect(calls.some((call) => call.action === "commitMedicationPhoto")).toBe(
    false,
  );
});
it("ten-second ambiguous field write survives service and queue restart using the identical requestId", async () => {
  const original = handler;
  handler = (data) =>
    data.action === "saveMedicationFast"
      ? new Promise(() => {})
      : original(data);
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/photo.jpg", "replace");
  const work = queue.run(job.id);
  const observation = observeSave(work, Date.now() + 10000);
  await vi.advanceTimersByTimeAsync(10000);
  await observation;
  expect((await work).status).toBe("failed");
  expect(queue.list()[0]?.uncertain).toBe(true);
  expect(files.size).toBe(1);
  const firstId = calls.find(
    (call) => call.action === "saveMedicationFast",
  )!.requestId;
  handler = original;
  service = createDataService("cloud");
  await service.bootstrap();
  const recovered = new SaveQueue(service);
  expect((await recovered.run(job.id)).status).toBe("ready");
  expect(
    calls
      .filter((call) => call.action === "saveMedicationFast")
      .map((call) => call.requestId),
  ).toEqual([firstId, firstId]);
});
it("lost completion response recovers attached media without resaving fields or reuploading", async () => {
  const original = handler;
  handler = (data) =>
    data.action === "completeMedicationPhotoUpload"
      ? new Promise(() => {})
      : original(data);
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/photo.jpg", "replace");
  const work = queue.run(job.id);
  await vi.advanceTimersByTimeAsync(10000);
  await work;
  expect(queue.list()[0]?.medicationId).toBe("med-new");
  handler = original;
  expect((await new SaveQueue(service).run(job.id)).status).toBe("ready");
  expect(
    calls.filter((call) => call.action === "saveMedicationFast"),
  ).toHaveLength(1);
  expect(
    calls.filter((call) => call.action === "completeMedicationPhotoUpload"),
  ).toHaveLength(1);
});
it("storage-full failure dispatches no cloud mutation and removes the copied file", () => {
  const queue = new SaveQueue(service);
  const setter = wx.setStorageSync.bind(wx);
  vi.spyOn(wx, "setStorageSync").mockImplementation(
    (key: string, value: unknown) => {
      if (key.includes("save-queue") && Array.isArray(value) && value.length)
        throw new Error("quota");
      setter(key, value);
    },
  );
  expect(() => queue.start(draft, "/tmp/photo.jpg", "replace")).toThrow(
    "quota",
  );
  expect(files.size).toBe(0);
  expect(calls.some((call) => call.action === "saveMedicationFast")).toBe(
    false,
  );
});
it("queue is account-isolated and deterministic conflicts stop automatic retries", async () => {
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/photo.jpg", "replace");
  service.syncScope = "account-B";
  expect(queue.list()).toEqual([]);
  await expect(queue.run(job.id)).rejects.toBeInstanceOf(ServiceError);
  service.syncScope = "account-A";
  handler = (data) =>
    data.action === "saveMedicationFast"
      ? Promise.resolve({
          result: {
            ok: false,
            error: { code: "VERSION_CONFLICT", message: "版本冲突" },
          },
        })
      : ok(null);
  expect((await queue.run(job.id)).terminal).toBe(true);
  const before = calls.length;
  await queue.resume();
  expect(calls.length).toBe(before);
});
it("deadline exhausted before next phase never starts an upload", async () => {
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/photo.jpg", "replace");
  expect((await queue.run(job.id, Date.now())).status).toBe("failed");
  expect(calls.filter((call) => call.action !== "bootstrap")).toHaveLength(0);
});
it("confirmed tasks retain thumbnail work across a later save and retry local cleanup", async () => {
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/photo.jpg", "replace");
  const manager = wx.getFileSystemManager();
  const unlink = manager.unlinkSync.bind(manager);
  vi.spyOn(wx, "getFileSystemManager").mockReturnValue({
    ...manager,
    unlinkSync: () => {
      throw new Error("busy file");
    },
  });
  expect((await queue.run(job.id)).status).toBe("ready");
  expect(queue.list()[0]?.filePath).toBeTruthy();
  queue.start({ ...draft, name: "next" }, "", "unchanged");
  expect(queue.list().some((item) => item.id === job.id)).toBe(true);
  vi.spyOn(wx, "getFileSystemManager").mockReturnValue({
    ...manager,
    unlinkSync: unlink,
  });
  await queue.resume();
  const ready = queue.list().find((item) => item.id === job.id);
  expect(ready?.filePath).toBe("");
  expect(ready?.derivativesDone).toBe(true);
  expect(calls.some((call) => call.action === "processMedicationPhoto")).toBe(
    true,
  );
});
it("uses the ticket returned with field confirmation without another prepare RPC", async () => {
  const original = handler;
  handler = async (data) => {
    if (data.action !== "saveMedicationFast") return original(data);
    expect(data.payload["preparePhoto"]).toBe(true);
    return ok({
      medication: saved,
      planId: null,
      photoTicket: {
        mediaId: "media-new",
        cloudPath: "medication-photos/test.jpg",
        maxBytes: 2097152,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        transport: "cloud",
        protocol: "chunks-v2",
      },
    });
  };
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/photo.jpg", "replace");
  expect((await queue.run(job.id)).status).toBe("ready");
  expect(calls.some((call) => call.action === "prepareMedicationPhoto")).toBe(
    false,
  );
});
it("missing local image is recoverable with a new request, without resaving fields", async () => {
  const original = handler;
  handler = (data) =>
    data.action === "bootstrap"
      ? ok({ ...bootstrap, medications: [saved] })
      : original(data);
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/old.jpg", "replace");
  files.clear();
  const failed = await queue.run(job.id);
  expect(failed.failureCode).toBe("LOCAL_FILE_MISSING");
  expect(failed.failureStage).toBe("photo");
  const repaired = await queue.reselectPhoto(job.id, "/tmp/new.jpg");
  expect(repaired.id).not.toBe(job.id);
  expect(repaired.status).toBe("ready");
  expect(
    calls.filter((call) => call.action === "saveMedicationFast"),
  ).toHaveLength(1);
});
it("reselection reconciles a previously attached ticket without changing the photo", async () => {
  const original = handler;
  handler = (data) =>
    data.action === "completeMedicationPhotoUpload"
      ? new Promise(() => {})
      : original(data);
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/old.jpg", "replace");
  const work = queue.run(job.id);
  await vi.advanceTimersByTimeAsync(10000);
  await work;
  handler = original;
  const repaired = await queue.reselectPhoto(job.id, "/tmp/new.jpg");
  expect(repaired.id).toBe(job.id);
  expect(repaired.status).toBe("ready");
  expect(
    calls.filter((call) => call.action === "completeMedicationPhotoUpload"),
  ).toHaveLength(1);
  expect(
    calls.filter((call) => call.action === "discardMedicationPhoto"),
  ).toHaveLength(0);
});
it("reselection refuses a changed box version without sending any replacement upload", async () => {
  const original = handler;
  handler = (data) =>
    data.action === "bootstrap"
      ? ok({ ...bootstrap, medications: [{ ...saved, version: 3 }] })
      : original(data);
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/old.jpg", "replace");
  files.clear();
  await queue.run(job.id);
  await expect(
    queue.reselectPhoto(job.id, "/tmp/new.jpg"),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(
    calls.filter((call) => call.action === "prepareMedicationPhoto"),
  ).toHaveLength(0);
  expect(queue.list()[0]?.id).toBe(job.id);
});
it("reselection waits for old ticket cleanup before using a new upload request", async () => {
  const original = handler;
  let discarded = false;
  handler = (data) => {
    if (data.action === "completeMedicationPhotoUpload")
      return new Promise(() => {});
    if (data.action === "bootstrap")
      return ok({ ...bootstrap, medications: [saved] });
    if (data.action === "getMedicationPhotoStatus")
      return ok({ status: discarded ? "deleted" : "prepared" });
    if (data.action === "discardMedicationPhoto") {
      discarded = true;
      return ok({ discarded: true });
    }
    return original(data);
  };
  const queue = new SaveQueue(service);
  const job = queue.start(draft, "/tmp/old.jpg", "replace");
  const work = queue.run(job.id);
  await vi.advanceTimersByTimeAsync(10000);
  await work;
  const repairHandler = handler;
  handler = (data) =>
    data.action === "completeMedicationPhotoUpload"
      ? original(data)
      : repairHandler(data);
  const repaired = await queue.reselectPhoto(job.id, "/tmp/new.jpg");
  expect(discarded).toBe(true);
  expect(repaired.status).toBe("ready");
  const prepares = calls.filter(
    (call) => call.action === "prepareMedicationPhoto",
  );
  expect(prepares).toHaveLength(2);
  expect(prepares[0]?.requestId).not.toBe(prepares[1]?.requestId);
  expect(
    calls.filter((call) => call.action === "saveMedicationFast"),
  ).toHaveLength(1);
});
