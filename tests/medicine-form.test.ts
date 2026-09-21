import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {} from "../miniprogram/types/global";
import type { MedicationDraft } from "../miniprogram/core/models";
import {
  createDataService,
  ServiceError,
  type DataService,
} from "../miniprogram/services/data-service";
import {
  commitStagedMedicationPhoto,
  stageMedicationPhoto,
} from "../miniprogram/services/medication-photo";

vi.mock("../miniprogram/services/medication-photo", () => ({
  selectMedicationPhoto: vi.fn(),
  stageMedicationPhoto: vi.fn(),
  commitStagedMedicationPhoto: vi.fn(),
  discardStagedMedicationPhoto: vi.fn(),
}));

interface FormPage {
  data: Record<string, unknown> & {
    saving: boolean;
    medicationId: string;
    expectedVersion: number;
    editing: boolean;
    saveError: string;
    photoSaveWarning: string;
    photoTempPath: string;
    times: string[];
  };
  setData(values: Record<string, unknown>, callback?: () => void): void;
  onLoad(options: Record<string, string>): Promise<void>;
  buildDraft(): MedicationDraft;
  save(): Promise<void>;
  addTime(): void;
  onTimeChange(event: WechatMiniprogram.CustomEvent<{ value: string }>): void;
}

let definition: FormPage;
let page: FormPage;
let service: DataService;
const storage = new Map<string, unknown>();
const showModal = vi.fn();
const redirectTo = vi.fn();
const navigateTo = vi.fn();
const hideLoading = vi.fn();

beforeAll(async () => {
  vi.stubGlobal("Page", (value: FormPage) => {
    definition = value;
  });
  await import("../miniprogram/pages/medicine-form/index");
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-03T03:00:00.000Z"));
  vi.clearAllMocks();
  storage.clear();
  showModal.mockResolvedValue({ confirm: true, cancel: false });
  redirectTo.mockResolvedValue({});
  navigateTo.mockResolvedValue({});
  vi.stubGlobal("wx", {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    showModal,
    redirectTo,
    navigateTo,
    hideLoading,
    showLoading: vi.fn(),
    showToast: vi.fn(),
    pageScrollTo: vi.fn(),
    enableAlertBeforeUnload: vi.fn(),
    disableAlertBeforeUnload: vi.fn(),
  });
  service = createDataService("local");
  const state = await service.acceptPrivacy("test");
  vi.stubGlobal("getApp", () => ({ getService: () => service }));
  page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values, callback) {
      Object.assign(this.data, values);
      callback?.();
    },
  };
  page.setData({
    loading: false,
    profiles: state.profiles,
    name: "照片回归测试药盒",
    expiryValue: "2027-09",
    usageMode: "scheduled",
    unitIndex: 0,
    startDate: "2026-09-03",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("药盒表单保存恢复", () => {
  it("保存服药计划后直接进入详情，不强制请求日历权限", async () => {
    await page.save();

    expect(page.data.saving).toBe(false);
    expect(page.data.editing).toBe(true);
    expect(page.data.expectedVersion).toBe(1);
    expect(showModal).not.toHaveBeenCalled();
    expect(redirectTo).toHaveBeenCalledWith({
      url: `/pages/medicine-detail/index?id=${page.data.medicationId}&saved=1`,
    });
    expect((await service.bootstrap()).plans[0]?.times).toEqual(["08:00"]);
  });

  it("照片服务版本不支持时不反复重试，药盒仍保存且解除按钮锁定", async () => {
    page.setData({ photoChange: "replace", photoTempPath: "/tmp/photo.jpg" });
    vi.mocked(stageMedicationPhoto).mockRejectedValue(
      new ServiceError("MEDIA_UNAVAILABLE", "照片服务尚未更新", false),
    );

    await page.save();

    expect(stageMedicationPhoto).toHaveBeenCalledOnce();
    expect(showModal).toHaveBeenCalledWith(
      expect.objectContaining({ showCancel: false, confirmText: "知道了" }),
    );
    expect(page.data.photoSaveWarning).toBe("照片服务尚未更新");
    expect(page.data.saving).toBe(false);
    expect((await service.bootstrap()).medications).toHaveLength(1);
    expect(redirectTo).not.toHaveBeenCalled();
  });

  it("照片错误弹窗本身失败也会解除保存状态，并保留已保存药盒 ID", async () => {
    page.setData({ photoChange: "replace", photoTempPath: "/tmp/photo.jpg" });
    vi.mocked(stageMedicationPhoto).mockRejectedValue(
      new ServiceError("NETWORK", "上传中断"),
    );
    showModal.mockRejectedValue(new Error("原生弹窗失败"));

    await page.save();

    expect(page.data.saving).toBe(false);
    expect(page.data.medicationId).not.toBe("");
    expect(page.data.photoTempPath).toBe("/tmp/photo.jpg");
    expect(page.data.saveError).toContain("药盒信息已保存");
    expect((await service.bootstrap()).medications).toHaveLength(1);
  });

  it("照片超时后先保留同一票据，重试只走照片步骤且不重复保存字段", async () => {
    page.setData({ photoChange: "replace", photoTempPath: "/tmp/photo.jpg" });
    const saveMedication = vi.spyOn(service, "saveMedication");
    const pending = {
      ticket: {
        mediaId: "media-timeout-1",
        cloudPath: "medication-photos/owner/media-timeout-1.jpg",
        expiresAt: "2099-01-01T00:00:00Z",
        maxBytes: 2097152,
        transport: "cloud" as const,
      },
      tempFilePath: "/tmp/photo.jpg",
    };
    const timeout = Object.assign(
      new ServiceError(
        "MEDIA_UNAVAILABLE",
        "照片服务响应超时，请稍后重试",
        true,
        "unknown",
      ),
      { pending },
    );
    vi.mocked(stageMedicationPhoto)
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ ...pending, fileId: "cloud://env/photo" });
    vi.mocked(commitStagedMedicationPhoto).mockImplementation(() =>
      service.bootstrap(),
    );

    await page.save();

    expect(saveMedication).toHaveBeenCalledOnce();
    expect(stageMedicationPhoto).toHaveBeenCalledTimes(2);
    expect(stageMedicationPhoto).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ticket: pending.ticket,
        tempFilePath: pending.tempFilePath,
      }),
    );
    expect(page.data.photoResume).toBeNull();
    expect(page.data.saving).toBe(false);
  });

  it("选择稍后重试仍保留诊断和票据，下次点击保存先回查已上传照片", async () => {
    page.setData({ photoChange: "replace", photoTempPath: "/tmp/photo.jpg" });
    const saveMedication = vi.spyOn(service, "saveMedication");
    const ticket = {
      mediaId: "media-resume-1",
      cloudPath: "medication-photos/owner/media-resume-1.jpg",
      expiresAt: "2099-01-01T00:00:00Z",
      maxBytes: 2097152,
      transport: "cloud" as const,
    };
    vi.mocked(stageMedicationPhoto).mockRejectedValueOnce(
      Object.assign(
        new ServiceError(
          "NETWORK",
          "网络连接失败，请稍后重试",
          true,
          "unknown",
        ),
        { pending: { ticket, tempFilePath: "/tmp/photo.jpg" } },
      ),
    );
    showModal.mockResolvedValueOnce({ confirm: false, cancel: true });
    await page.save();
    expect(redirectTo).not.toHaveBeenCalled();
    expect(page.data.photoAttemptId).toBeTruthy();
    expect(page.data.photoResume).toMatchObject({ ticket });
    expect(page.data.saving).toBe(false);
    vi.spyOn(service, "getMedicationPhotoStatus").mockResolvedValue({
      medicationId: page.data.medicationId,
      mediaId: ticket.mediaId,
      status: "uploaded",
      expiresAt: ticket.expiresAt,
      fileId: "cloud://env/photo",
    });
    vi.mocked(commitStagedMedicationPhoto).mockImplementation(() =>
      service.bootstrap(),
    );
    await page.save();
    expect(saveMedication).toHaveBeenCalledOnce();
    expect(stageMedicationPhoto).toHaveBeenCalledOnce();
    expect(commitStagedMedicationPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        staged: { ticket, fileId: "cloud://env/photo" },
      }),
    );
    expect(page.data.photoResume).toBeNull();
    expect(page.data.photoSaveWarning).toBe("");
    expect(redirectTo).toHaveBeenCalledOnce();
  });

  it("回查时照片刚完成绑定会刷新药盒，不把旧的无照片状态当作最终结果", async () => {
    page.setData({ photoChange: "replace", photoTempPath: "/tmp/photo.jpg" });
    const ticket = {
      mediaId: "media-late-1",
      cloudPath: "medication-photos/owner/media-late-1.jpg",
      expiresAt: "2099-01-01T00:00:00Z",
      maxBytes: 2097152,
      transport: "cloud" as const,
    };
    vi.mocked(stageMedicationPhoto).mockRejectedValueOnce(
      Object.assign(
        new ServiceError("NETWORK", "网络连接失败", true, "unknown"),
        { pending: { ticket, tempFilePath: "/tmp/photo.jpg" } },
      ),
    );
    showModal.mockResolvedValueOnce({ confirm: false, cancel: true });
    await page.save();
    const stale = await service.bootstrap();
    const attached = structuredClone(stale);
    attached.medications[0]!.photo = {
      mediaId: ticket.mediaId,
      fileId: "cloud://env/photo",
      updatedAt: new Date().toISOString(),
    };
    attached.medications[0]!.version = 2;
    const bootstrap = vi
      .spyOn(service, "bootstrap")
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(attached);
    vi.spyOn(service, "getMedicationPhotoStatus").mockResolvedValue({
      medicationId: page.data.medicationId,
      mediaId: ticket.mediaId,
      status: "attached",
      fileId: "cloud://env/photo",
      expiresAt: null,
    });
    await page.save();
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(stageMedicationPhoto).toHaveBeenCalledOnce();
    expect(commitStagedMedicationPhoto).not.toHaveBeenCalled();
    expect(page.data.expectedVersion).toBe(2);
    expect(page.data.photoPreview).toBe("cloud://env/photo");
    expect(page.data.photoSaveWarning).toBe("");
  });

  it("照片成功后保存最新版本，返回表单再次保存不会重复上传", async () => {
    page.setData({ photoChange: "replace", photoTempPath: "/tmp/photo.jpg" });
    vi.mocked(stageMedicationPhoto).mockImplementation(async (args) => ({
      ticket: await args.service.prepareMedicationPhoto(
        args.medicationId,
        args.expectedVersion,
      ),
      fileId: "/saved/photo.jpg",
    }));
    vi.mocked(commitStagedMedicationPhoto).mockImplementation((args) =>
      args.service.commitMedicationPhoto({
        medicationId: args.medicationId,
        expectedVersion: args.expectedVersion,
        mediaId: args.staged.ticket.mediaId,
        fileId: args.staged.fileId,
      }),
    );
    redirectTo.mockRejectedValue(new Error("页面跳转失败"));
    navigateTo.mockRejectedValue(new Error("页面跳转失败"));

    await page.save();
    expect(page.data.expectedVersion).toBe(2);
    expect(page.data.photoTempPath).toBe("");
    expect(page.data.photoChange).toBe("unchanged");
    await page.save();

    expect(stageMedicationPhoto).toHaveBeenCalledOnce();
    expect(page.data.expectedVersion).toBe(3);
    expect((await service.bootstrap()).medications).toHaveLength(1);
    expect((await service.bootstrap()).medications[0]?.photo?.fileId).toBe(
      "/saved/photo.jpg",
    );
  });

  it("照片连续失败后重试只恢复照片，不重复保存药盒或初始数量记录", async () => {
    page.setData({
      photoChange: "replace",
      photoTempPath: "/tmp/photo.jpg",
      quantityOpen: true,
      quantity: "20",
    });
    vi.mocked(stageMedicationPhoto).mockRejectedValue(
      new ServiceError("NETWORK", "上传中断"),
    );
    redirectTo.mockRejectedValue(new Error("页面跳转失败"));
    navigateTo.mockRejectedValue(new Error("页面跳转失败"));

    await page.save();
    const firstId = page.data.medicationId;
    expect(page.data.saving).toBe(false);
    expect(page.buildDraft()).toMatchObject({
      id: firstId,
      expectedVersion: 1,
      initialQuantityMilli: null,
    });
    await page.save();

    const persisted = await service.bootstrap();
    expect(persisted.medications).toHaveLength(1);
    expect(persisted.medications[0]?.id).toBe(firstId);
    expect(persisted.medications[0]?.version).toBe(1);
    expect(persisted.snapshots).toHaveLength(1);
    expect(page.data.saving).toBe(false);
    expect(hideLoading).toHaveBeenCalled();
  });

  it("基础信息保存失败时保留新建草稿并解除保存状态", async () => {
    vi.spyOn(service, "saveMedication").mockRejectedValue(
      new ServiceError("NETWORK", "网络连接失败"),
    );

    await page.save();

    expect(page.data.saving).toBe(false);
    expect(page.data.medicationId).toBe("");
    expect(page.data.editing).toBe(false);
    expect(page.data.saveError).toBe("网络连接失败");
    expect(redirectTo).not.toHaveBeenCalled();
  });

  it("时间选择可保存，新加时间在六项以内保持不同", async () => {
    page.onTimeChange({
      currentTarget: { dataset: { index: 0 } },
      detail: { value: "09:35" },
    } as unknown as WechatMiniprogram.CustomEvent<{ value: string }>);
    for (let count = 0; count < 6; count += 1) page.addTime();
    expect(page.data.times).toHaveLength(6);
    expect(new Set(page.data.times).size).toBe(6);
    expect(page.data.times[0]).toBe("09:35");

    await page.save();
    expect((await service.bootstrap()).plans[0]?.times).toContain("09:35");
    expect(page.data.saving).toBe(false);
  });
});

it("new-box form reads the current account source and clears all per-box state", async () => {
  const saved = await service.saveMedication({
    ...page.buildDraft(),
    storageLocation: "客厅",
    initialQuantityMilli: 18000,
  });
  page.data = structuredClone(definition.data);
  await page.onLoad({ copyFrom: saved.medicationId });
  const draft = page.buildDraft();
  expect(draft.id).toBeUndefined();
  expect(draft).toMatchObject({
    name: "照片回归测试药盒",
    storageLocation: "客厅",
    mode: "expiry_only",
    expiryValue: "",
    openedDate: null,
    afterOpenDays: null,
    initialQuantityMilli: null,
    schedule: null,
  });
  expect(page.data.photoTempPath).toBe("");
  const state = await service.bootstrap();
  expect(state.medications).toHaveLength(1);
  expect(state.snapshots[0]?.quantityMilli).toBe(18000);
});
it("local old-client edit preserves location and explicit blank clears it", async () => {
  const draft = page.buildDraft();
  const saved = await service.saveMedication({
    ...draft,
    storageLocation: "客厅",
  });
  const med = saved.state.medications[0]!;
  const { storageLocation: _location, ...oldDraft } = draft;
  void _location;
  const edited = await service.saveMedication({
    ...oldDraft,
    id: med.id,
    expectedVersion: med.version,
  });
  expect(edited.state.medications[0]?.storageLocation).toBe("客厅");
  const cleared = await service.saveMedication({
    ...draft,
    id: med.id,
    expectedVersion: edited.state.medications[0]!.version,
    storageLocation: "",
  });
  expect(cleared.state.medications[0]?.storageLocation).toBe("");
});
