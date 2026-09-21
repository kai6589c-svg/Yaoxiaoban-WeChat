import { newBoxPrefill } from "../../core/medication-copy";
import { buildPlanPreview } from "../../core/plan-preview";
import { saveJobView } from "../../services/save-job-view";
import {
  getSaveQueue,
  observeSave,
  SAVE_BUDGET_MS,
  type SaveJob,
} from "../../services/save-queue";
import { daysBetween, formatChineseDate, todayKey } from "../../core/dates";
import { calculateEffectiveExpiry, resolveExpiry } from "../../core/expiry";
import type {
  AppState,
  FormState,
  MedicationDraft,
  MedicationMode,
} from "../../core/models";
import { FORM_STATE, MEDICATION_MODE, SCHEDULE_TYPE } from "../../core/status";
import { validateMedicationDraft } from "../../core/validation";
import {
  ServiceError,
  type DataService,
  type SaveMedicationResult,
} from "../../services/data-service";
import {
  commitStagedMedicationPhoto,
  discardStagedMedicationPhoto,
  selectMedicationPhoto,
  stageMedicationPhoto,
  type PendingMedicationPhoto,
  type StagedMedicationPhoto,
} from "../../services/medication-photo";
import {
  createPhotoAttempt,
  photoAttemptReport,
  recordPhotoEvent,
} from "../../services/diagnostics";
import { showError } from "../../services/ui";

const isPhotoOperationError = (
  error: unknown,
): error is ServiceError & { pending: PendingMedicationPhoto } =>
  error instanceof ServiceError &&
  Boolean(
    (error as ServiceError & { pending?: PendingMedicationPhoto }).pending,
  );

const UNIT_OPTIONS = [
  "片",
  "粒",
  "袋",
  "支",
  "毫升",
  "滴",
  "喷",
  "贴",
  "丸",
  "克",
];

const WEEKDAYS = [
  { value: 1, label: "一", selected: true },
  { value: 2, label: "二", selected: true },
  { value: 3, label: "三", selected: true },
  { value: 4, label: "四", selected: true },
  { value: 5, label: "五", selected: true },
  { value: 6, label: "六", selected: true },
  { value: 7, label: "日", selected: true },
];

const decimalToMilli = (value: string): number => {
  const normalized = value.trim();
  if (!/^(?:\d+|\d*\.\d{1,3})$/.test(normalized)) return Number.NaN;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : Number.NaN;
};

const formatDecimal = (value: number): string =>
  Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");

Page({
  data: {
    loading: true,
    copyFromId: "",
    storageLocation: "",
    locationSuggestions: [] as string[],
    error: "",
    saveError: "",
    planPreview: {
      days: [] as Array<{ date: string; text: string }>,
      message: "",
    },
    photoSaveWarning: "",
    pendingSaveId: "",
    saving: false,
    editing: false,
    formState: FORM_STATE.CLEAN as FormState,
    medicationId: "",
    expectedVersion: 0,
    profiles: [] as Array<{ id: string; name: string }>,
    profileIndex: 0,
    name: "",
    nameFocus: false,
    allSuggestions: [] as string[],
    suggestions: [] as string[],
    specification: "",
    note: "",
    detailsOpen: false,
    today: todayKey(),
    expiryPrecision: "month" as "day" | "month",
    expiryValue: "",
    pickerExpiry: todayKey(),
    expiryPreviewTitle: "",
    expiryPreviewDetail: "",
    expiryPreviewClass: "",
    usageMode: MEDICATION_MODE.EXPIRY_ONLY as MedicationMode,
    repeatKind: SCHEDULE_TYPE.DAILY as "daily" | "weekly",
    dose: "1",
    times: ["08:00"] as string[],
    weekdays: WEEKDAYS,
    startDate: todayKey(),
    hasEndDate: false,
    endDate: todayKey(),
    planDatesOpen: false,
    quantityOpen: false,
    quantity: "",
    unitOptions: UNIT_OPTIONS,
    unitIndex: -1,
    unitLocked: false,
    unitLockText: "",
    openedDateEnabled: false,
    openedDate: todayKey(),
    afterOpenDays: "",
    originalPhotoUrl: "",
    photoPreview: "",
    photoTempPath: "",
    photoChange: "unchanged" as "unchanged" | "replace" | "remove",
    photoBusy: false,
    photoPreviewError: false,
    photoSizeText: "",
    photoAttemptId: "",
    photoResume: null as PendingMedicationPhoto | null,
    fieldErrors: {} as Record<string, string>,
  },

  async onLoad(options: Record<string, string | undefined>) {
    const medicationId = options["id"] ?? "";
    this.setData({
      copyFromId: medicationId ? "" : (options["copyFrom"] ?? ""),
    });
    if (medicationId) {
      this.setData({ editing: true, medicationId });
      void wx.setNavigationBarTitle({ title: "编辑药盒" });
    }
    await this.loadData();
  },

  async loadData() {
    this.setData({ loading: true, error: "" });
    try {
      const state = await getApp<IAppOption>().getService().bootstrap();
      this.setData({
        locationSuggestions: [
          ...new Set(
            state.medications
              .map((item) => item.storageLocation?.trim() ?? "")
              .filter(Boolean),
          ),
        ].slice(0, 8),
      });
      const profiles = state.profiles
        .filter((item) => !item.archivedAt)
        .map(({ id, name }) => ({ id, name }));
      const allSuggestions = Array.from(
        new Set(state.medications.map((item) => item.name)),
      ).slice(0, 8);
      if (this.data.editing) {
        this.populateExisting(state, profiles, allSuggestions);
      } else {
        this.setData({
          profiles,
          allSuggestions,
          suggestions: [],
          loading: false,
          formState: FORM_STATE.CLEAN,
        });
        if (this.data.copyFromId) {
          const source = state.medications.find(
            (item) => item.id === this.data.copyFromId,
          );
          if (!source) throw new Error("原药盒不存在，请从药箱重新选择");
          const prefill = newBoxPrefill(source);
          const profileIndex = profiles.findIndex(
            (item) => item.id === prefill.profileId,
          );
          if (profileIndex < 0)
            throw new Error("所属成员已归档，请先选择活动成员");
          const unitOptions =
            this.data.unitOptions.includes(prefill.unit) || !prefill.unit
              ? this.data.unitOptions
              : [...this.data.unitOptions, prefill.unit];
          this.setData({
            name: prefill.name,
            specification: prefill.specification,
            storageLocation: prefill.storageLocation,
            profileIndex,
            unitOptions,
            unitIndex: unitOptions.indexOf(prefill.unit),
            expiryValue: "",
            quantity: "",
            usageMode: "expiry_only",
            formState: FORM_STATE.DIRTY,
          });
        }
      }
    } catch (error) {
      showError(error, "没有加载成功");
      this.setData({
        loading: false,
        error: error instanceof Error ? error.message : "没有加载成功",
      });
    }
  },

  onShow() {
    if (!this.data.pendingSaveId || this.data.saving) return;
    const queue = getSaveQueue(getApp<IAppOption>().getService());
    const job = queue
      .list()
      .find((item) => item.id === this.data.pendingSaveId);
    if (!job || job.status === "ready") {
      this.setData({ pendingSaveId: "", photoSaveWarning: "" });
      if (job?.medicationId)
        this.setData({ medicationId: job.medicationId, editing: true });
      if (this.data.medicationId) void this.loadData();
    }
  },

  retry() {
    void this.loadData();
  },

  populateExisting(
    state: AppState,
    profiles: Array<{ id: string; name: string }>,
    allSuggestions: string[],
  ) {
    const medication = state.medications.find(
      (item) => item.id === this.data.medicationId,
    );
    if (!medication) {
      showError(new Error("药品不存在"));
      void wx.navigateBack();
      return;
    }
    const plan = state.plans.find(
      (item) =>
        item.medicationId === medication.id && item.effectiveTo === null,
    );
    const profileIndex = Math.max(
      0,
      profiles.findIndex((item) => item.id === medication.profileId),
    );
    const unitOptions =
      medication.unit && !UNIT_OPTIONS.includes(medication.unit)
        ? [...UNIT_OPTIONS, medication.unit]
        : UNIT_OPTIONS;
    const unitIndex = medication.unit
      ? unitOptions.indexOf(medication.unit)
      : -1;
    const unitLocked = Boolean(
      medication.unit &&
      (state.snapshots.some((item) => item.medicationId === medication.id) ||
        state.intakeLogs.some((item) => item.medicationId === medication.id) ||
        state.plans.some((item) => item.medicationId === medication.id)),
    );
    const weekdays = WEEKDAYS.map((day) => ({
      ...day,
      selected:
        plan?.scheduleType === SCHEDULE_TYPE.WEEKLY
          ? plan.weekdays.includes(day.value)
          : true,
    }));
    const currentToday = todayKey();
    this.setData(
      {
        profiles,
        allSuggestions,
        suggestions: [],
        loading: false,
        expectedVersion: medication.version,
        profileIndex,
        name: medication.name,
        specification: medication.specification,
        storageLocation: medication.storageLocation ?? "",
        note: medication.note,
        detailsOpen: Boolean(medication.specification || medication.note),
        expiryPrecision: medication.expiryPrecision,
        expiryValue: medication.expiryValue,
        pickerExpiry:
          medication.expiryPrecision === "month"
            ? `${medication.expiryValue}-01`
            : medication.expiryValue,
        unitOptions,
        unitIndex,
        unitLocked,
        unitLockText: unitLocked
          ? "已有计划、盘点或使用记录；为避免改写历史单位，请新建另一盒"
          : "",
        openedDateEnabled: Boolean(medication.openedDate),
        openedDate: medication.openedDate ?? currentToday,
        afterOpenDays: medication.afterOpenDays
          ? String(medication.afterOpenDays)
          : "",
        usageMode: medication.mode,
        repeatKind:
          plan?.scheduleType === SCHEDULE_TYPE.WEEKLY
            ? SCHEDULE_TYPE.WEEKLY
            : SCHEDULE_TYPE.DAILY,
        dose: plan ? String(plan.doseMilli / 1000) : "1",
        times: plan?.times.length ? plan.times : ["08:00"],
        weekdays,
        startDate: plan?.startDate ?? currentToday,
        hasEndDate: Boolean(plan?.endDate),
        endDate: plan?.endDate ?? currentToday,
        planDatesOpen: Boolean(
          plan && (plan.startDate !== currentToday || plan.endDate),
        ),
        originalPhotoUrl:
          medication.photo?.url ?? medication.photo?.fileId ?? "",
        photoPreview: medication.photo?.url ?? medication.photo?.fileId ?? "",
        photoTempPath: "",
        photoChange: "unchanged",
        photoPreviewError: false,
        photoSizeText: "",
        formState: FORM_STATE.CLEAN,
      },
      () => {
        this.refreshExpiryPreview();
        this.refreshPlanPreview();
      },
    );
  },

  updateDraft(patch: Record<string, unknown>, callback?: () => void) {
    if (this.data.pendingSaveId) {
      void wx.showToast({
        title: "请先处理待同步任务，再修改药盒",
        icon: "none",
      });
      return;
    }
    if (
      this.data.formState === FORM_STATE.CLEAN ||
      this.data.formState === FORM_STATE.ERROR ||
      this.data.formState === FORM_STATE.SAVED
    ) {
      try {
        wx.enableAlertBeforeUnload({
          message: "还有未保存的药盒信息，确定离开吗？",
        });
      } catch {
        // Older clients may not expose the leave guard; draft preservation on
        // save errors remains available independently.
      }
    }
    this.setData({ ...patch, formState: FORM_STATE.DIRTY }, () => {
      callback?.();
      this.refreshPlanPreview();
    });
  },

  /**
   * Clears the native leave guard after a persistence operation that was
   * initiated outside the visible submit button (for example, an automated
   * journey or a host integration). Keeping this on the page instance makes
   * the operation apply to the actual current page rather than an app-level
   * bridge callback.
   */
  clearLeaveGuard() {
    try {
      wx.disableAlertBeforeUnload();
    } catch {
      // Older base libraries do not expose the leave guard API.
    }
  },

  onNameInput(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const name = event.detail.value;
    const query = name.trim();
    this.updateDraft({
      name,
      suggestions: this.data.allSuggestions.filter(
        (item) => query && item.includes(query) && item !== query,
      ),
    });
  },

  chooseSuggestion(event: WechatMiniprogram.BaseEvent) {
    this.updateDraft({
      name: String(event.currentTarget.dataset["name"] ?? ""),
      suggestions: [],
    });
  },

  onSpecificationInput(
    event: WechatMiniprogram.CustomEvent<{ value: string }>,
  ) {
    this.updateDraft({ specification: event.detail.value });
  },

  onLocationInput(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.updateDraft({ storageLocation: event.detail.value });
  },
  chooseLocation(event: WechatMiniprogram.BaseEvent) {
    this.updateDraft({
      storageLocation: String(event.currentTarget.dataset["location"] ?? ""),
    });
  },
  onNoteInput(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.updateDraft({ note: event.detail.value });
  },

  onProfileChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.updateDraft({ profileIndex: Number(event.detail.value) });
  },

  async choosePrecision(event: WechatMiniprogram.BaseEvent) {
    if (event.currentTarget.dataset["precision"] !== this.data.expiryPrecision)
      await this.togglePrecisionMode();
  },
  async togglePrecisionMode() {
    if (this.data.expiryValue) {
      const switchingToDay = this.data.expiryPrecision === "month";
      const decision = await wx.showModal({
        title: switchingToDay ? "改为完整日期？" : "改为只记月份？",
        content: switchingToDay
          ? "月份不能推断包装上的具体日期，切换后需要重新选择完整日期。"
          : "切换后只保留月份，并按该月最后一天管理。",
        cancelText: "取消",
        confirmText: "继续切换",
        confirmColor: "#167A50",
      });
      if (!decision.confirm) return;
    }
    const nextPrecision =
      this.data.expiryPrecision === "month" ? "day" : "month";
    const nextValue =
      nextPrecision === "month" && this.data.expiryValue
        ? this.data.expiryValue.slice(0, 7)
        : "";
    this.updateDraft(
      {
        expiryPrecision: nextPrecision,
        expiryValue: nextValue,
      },
      () => this.refreshExpiryPreview(),
    );
  },

  onExpiryChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const value = event.detail.value;
    this.updateDraft(
      {
        pickerExpiry: value,
        expiryValue:
          this.data.expiryPrecision === "month" ? value.slice(0, 7) : value,
      },
      () => this.refreshExpiryPreview(),
    );
  },

  async choosePhoto() {
    if (this.data.photoBusy || this.data.saving) return;
    const photoAttemptId = createPhotoAttempt();
    const previousPreview = this.data.photoPreview;
    this.setData({ photoBusy: true });
    try {
      const selected = await selectMedicationPhoto({
        attemptId: photoAttemptId,
        onSelected: (photoPreview) =>
          this.setData({ photoPreview, photoPreviewError: false }),
      });
      if (!selected) return;
      this.updateDraft({
        photoAttemptId,
        photoResume: null,
        photoPreview: selected.tempFilePath,
        photoTempPath: selected.tempFilePath,
        photoChange: "replace",
        photoPreviewError: false,
        photoSizeText: `${Math.max(1, Math.ceil(selected.byteSize / 1024))} KB`,
      });
    } catch (error) {
      this.setData({ photoPreview: previousPreview });
      showError(error, "没有取得照片");
    } finally {
      this.setData({ photoBusy: false });
    }
  },

  async removePhoto() {
    if (!this.data.photoPreview) return;
    const decision = await wx.showModal({
      title: "移除药盒照片？",
      content: "保存后，这张照片将不再显示在药箱中。",
      cancelText: "保留",
      confirmText: "移除",
      confirmColor: "#B63D3D",
    });
    if (!decision.confirm) return;
    this.updateDraft({
      photoPreview: "",
      photoTempPath: "",
      photoChange: this.data.originalPhotoUrl ? "remove" : "unchanged",
      photoPreviewError: false,
      photoSizeText: "",
    });
  },

  previewPhoto() {
    if (!this.data.photoPreview || this.data.photoPreviewError) return;
    if (this.data.photoAttemptId)
      recordPhotoEvent({
        attemptId: this.data.photoAttemptId,
        stage: "preview",
        outcome: "start",
      });
    void wx.previewImage({
      current: this.data.photoPreview,
      urls: [this.data.photoPreview],
      success: () => {
        if (this.data.photoAttemptId)
          recordPhotoEvent({
            attemptId: this.data.photoAttemptId,
            stage: "preview",
            outcome: "success",
          });
      },
      fail: (error) => {
        if (this.data.photoAttemptId)
          recordPhotoEvent({
            attemptId: this.data.photoAttemptId,
            stage: "preview",
            outcome: "failure",
            error,
          });
      },
    });
  },

  onPhotoPreviewError() {
    this.setData({ photoPreviewError: true });
    if (this.data.photoAttemptId)
      recordPhotoEvent({
        attemptId: this.data.photoAttemptId,
        stage: "preview",
        outcome: "failure",
        errorCategory: "preview_error",
        sanitizedErrMsg: "image preview failed",
      });
  },

  selectUsageMode(event: WechatMiniprogram.BaseEvent) {
    const value = String(event.currentTarget.dataset["mode"] ?? "");
    if (!Object.values(MEDICATION_MODE).includes(value as MedicationMode))
      return;
    this.updateDraft({ usageMode: value as MedicationMode });
  },

  selectRepeatKind(event: WechatMiniprogram.BaseEvent) {
    const value = String(event.currentTarget.dataset["kind"] ?? "");
    if (value !== SCHEDULE_TYPE.DAILY && value !== SCHEDULE_TYPE.WEEKLY) return;
    this.updateDraft({ repeatKind: value });
  },

  onDoseInput(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.updateDraft({ dose: event.detail.value });
  },

  adjustDose(delta: number) {
    const current = Number(this.data.dose);
    const base = Number.isFinite(current) && current > 0 ? current : 1;
    this.updateDraft({ dose: formatDecimal(Math.max(0.5, base + delta)) });
  },

  decreaseDose() {
    this.adjustDose(-0.5);
  },

  increaseDose() {
    this.adjustDose(0.5);
  },

  onTimeChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const index = Number(event.currentTarget.dataset["index"]);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.data.times.length ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(event.detail.value)
    ) {
      return;
    }
    const times = [...this.data.times];
    times[index] = event.detail.value;
    this.updateDraft({ times });
  },

  addTime() {
    if (this.data.times.length >= 6) {
      void wx.showToast({ title: "最多设置6个时间", icon: "none" });
      return;
    }
    const candidate = [
      "08:00",
      "12:00",
      "18:00",
      "20:00",
      "21:00",
      "22:00",
    ].find((time) => !this.data.times.includes(time));
    this.updateDraft({
      times: [...this.data.times, candidate ?? "21:00"],
    });
  },

  removeTime(event: WechatMiniprogram.BaseEvent) {
    const index = Number(event.currentTarget.dataset["index"]);
    if (this.data.times.length <= 1) return;
    this.updateDraft({
      times: this.data.times.filter((_, itemIndex) => itemIndex !== index),
    });
  },

  toggleWeekday(event: WechatMiniprogram.BaseEvent) {
    const value = Number(event.currentTarget.dataset["value"]);
    this.updateDraft({
      weekdays: this.data.weekdays.map((day) =>
        day.value === value ? { ...day, selected: !day.selected } : day,
      ),
    });
  },

  togglePlanDates() {
    this.updateDraft({ planDatesOpen: !this.data.planDatesOpen });
  },

  onStartDateChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.updateDraft({ startDate: event.detail.value });
  },

  toggleEndDate(event: WechatMiniprogram.CustomEvent<{ value: boolean }>) {
    this.updateDraft({ hasEndDate: event.detail.value });
  },

  onEndDateChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.updateDraft({ endDate: event.detail.value });
  },

  async toggleQuantity() {
    if (this.data.quantityOpen && this.data.quantity.trim()) {
      const decision = await wx.showModal({
        title: "移除这次数量记录？",
        content: "关闭后，本次填写的数量不会保存。",
        cancelText: "继续填写",
        confirmText: "移除",
        confirmColor: "#B63D3D",
      });
      if (!decision.confirm) return;
      this.updateDraft({ quantityOpen: false, quantity: "" });
      return;
    }
    this.updateDraft({ quantityOpen: !this.data.quantityOpen });
  },

  onQuantityInput(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.updateDraft({ quantity: event.detail.value });
  },

  onUnitChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.unitLocked) return;
    this.updateDraft({ unitIndex: Number(event.detail.value) });
  },

  async toggleOpenedDetails() {
    if (
      this.data.openedDateEnabled &&
      (this.data.afterOpenDays.trim() || this.data.openedDate !== todayKey())
    ) {
      const decision = await wx.showModal({
        title: "移除开封信息？",
        content: "关闭后，开启日期和开封后期限不会保存。",
        cancelText: "继续填写",
        confirmText: "移除",
        confirmColor: "#B63D3D",
      });
      if (!decision.confirm) return;
    }
    this.updateDraft(
      {
        openedDateEnabled: !this.data.openedDateEnabled,
        ...(this.data.openedDateEnabled ? { afterOpenDays: "" } : {}),
      },
      () => this.refreshExpiryPreview(),
    );
  },

  onOpenedDateChange(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.updateDraft({ openedDate: event.detail.value }, () =>
      this.refreshExpiryPreview(),
    );
  },

  onAfterOpenDaysInput(
    event: WechatMiniprogram.CustomEvent<{ value: string }>,
  ) {
    this.updateDraft({ afterOpenDays: event.detail.value }, () =>
      this.refreshExpiryPreview(),
    );
  },

  toggleDetails() {
    this.updateDraft({ detailsOpen: !this.data.detailsOpen });
  },

  refreshExpiryPreview() {
    const result = calculateEffectiveExpiry({
      expiryPrecision: this.data.expiryPrecision,
      expiryValue: this.data.expiryValue,
      openedDate: this.data.openedDateEnabled ? this.data.openedDate : null,
      afterOpenDays:
        this.data.openedDateEnabled && this.data.afterOpenDays
          ? Number(this.data.afterOpenDays)
          : null,
    });
    if (!result) {
      this.setData({
        expiryPreviewTitle: "",
        expiryPreviewDetail: "",
        expiryPreviewClass: "",
      });
      return;
    }
    const remainingDays = daysBetween(todayKey(), result.effectiveExpiryDate);
    const expiryPreviewTitle =
      remainingDays < 0
        ? `管理期限已过去 ${Math.abs(remainingDays)} 天`
        : remainingDays === 0
          ? "管理期限是今天"
          : remainingDays === 1
            ? "管理期限是明天"
            : `距离管理期限还有 ${remainingDays} 天`;
    const expiryPreviewDetail =
      result.source === "after-open"
        ? `开启当天记作第1天，按开封后期限管理至${formatChineseDate(result.effectiveExpiryDate)}；包装标注至${formatChineseDate(this.data.expiryValue, this.data.expiryPrecision)}。`
        : this.data.expiryPrecision === "month"
          ? `包装只标到月份，按当月最后一天（${formatChineseDate(result.packageExpiryDate)}）管理。`
          : `按包装完整日期${formatChineseDate(result.packageExpiryDate)}管理。`;
    this.setData({
      expiryPreviewTitle,
      expiryPreviewDetail,
      expiryPreviewClass:
        remainingDays < 0
          ? "danger"
          : remainingDays <= 30
            ? "warning"
            : "normal",
    });
  },

  refreshPlanPreview() {
    this.setData({ planPreview: buildPlanPreview(this.buildDraft()) });
  },

  buildDraft(): MedicationDraft {
    const profile = this.data.profiles[this.data.profileIndex];
    const quantityMilli = decimalToMilli(this.data.quantity);
    const doseMilli = decimalToMilli(this.data.dose);
    const unit = this.data.unitOptions[this.data.unitIndex] ?? "";
    const mode = this.data.usageMode;
    return {
      id: this.data.medicationId || undefined,
      profileId: profile?.id ?? "",
      name: this.data.name,
      specification: this.data.specification,
      storageLocation: this.data.storageLocation,
      unit,
      mode,
      expiryPrecision: this.data.expiryPrecision,
      expiryValue: this.data.expiryValue,
      openedDate: this.data.openedDateEnabled ? this.data.openedDate : null,
      afterOpenDays:
        this.data.openedDateEnabled && this.data.afterOpenDays
          ? Number(this.data.afterOpenDays)
          : null,
      note: this.data.note,
      expectedVersion: this.data.editing
        ? this.data.expectedVersion
        : undefined,
      initialQuantityMilli: this.data.quantityOpen ? quantityMilli : null,
      schedule:
        mode === MEDICATION_MODE.EXPIRY_ONLY
          ? null
          : {
              type:
                mode === MEDICATION_MODE.AS_NEEDED
                  ? SCHEDULE_TYPE.AS_NEEDED
                  : this.data.repeatKind,
              startDate: this.data.startDate,
              endDate: this.data.hasEndDate ? this.data.endDate : null,
              weekdays: this.data.weekdays
                .filter((day) => day.selected)
                .map((day) => day.value),
              times: mode === MEDICATION_MODE.AS_NEEDED ? [] : this.data.times,
              doseMilli,
            },
    };
  },

  async applyPhotoChange(
    result: SaveMedicationResult,
    service: DataService,
    attemptId?: string,
  ): Promise<AppState> {
    const activeAttemptId = attemptId ?? String(this.data.photoAttemptId ?? "");
    const medication = result.state.medications.find(
      (item) => item.id === result.medicationId,
    );
    if (!medication) throw new ServiceError("NOT_FOUND", "已保存的药盒不存在");
    if (this.data.photoChange === "remove") {
      const context = activeAttemptId
        ? {
            attemptId: activeAttemptId,
            stage: "commit" as const,
            transport: "relay" as const,
          }
        : undefined;
      return context
        ? service.removeMedicationPhoto(
            medication.id,
            medication.version,
            context,
          )
        : service.removeMedicationPhoto(medication.id, medication.version);
    }
    if (this.data.photoChange !== "replace" || !this.data.photoTempPath) {
      return result.state;
    }

    let staged: StagedMedicationPhoto | null =
      this.data.photoResume?.staged ?? null;
    try {
      if (!staged) {
        staged = await stageMedicationPhoto({
          service,
          medicationId: medication.id,
          expectedVersion: medication.version,
          tempFilePath: this.data.photoTempPath,
          attemptId: activeAttemptId,
          ticket: this.data.photoResume?.ticket,
        });
      }
      const committed = await commitStagedMedicationPhoto({
        service,
        medicationId: medication.id,
        expectedVersion: medication.version,
        staged,
        attemptId: activeAttemptId,
      });
      this.setData({ photoResume: null });
      if (activeAttemptId)
        recordPhotoEvent({
          attemptId: activeAttemptId,
          stage: "read_back",
          outcome: "success",
        });
      return committed;
    } catch (error) {
      if (isPhotoOperationError(error)) {
        this.setData({ photoResume: error.pending });
      } else if (staged) {
        if (error instanceof ServiceError && error.outcome === "unknown") {
          this.setData({
            photoResume: {
              ticket: staged.ticket,
              tempFilePath: this.data.photoTempPath,
              staged,
            },
          });
        } else {
          await discardStagedMedicationPhoto(
            service,
            staged,
            activeAttemptId,
          ).catch(() => undefined);
        }
      }
      throw error;
    }
  },

  async resumePhotoChange(
    medicationId: string,
    service: DataService,
    photoAttemptId: string,
  ): Promise<AppState> {
    const reconcileStartedAtMs = Date.now();
    recordPhotoEvent({
      attemptId: photoAttemptId,
      stage: "retry_bootstrap",
      outcome: "start",
      startedAtMs: reconcileStartedAtMs,
    });
    const latestState = await service.bootstrap().then(
      (state) => {
        recordPhotoEvent({
          attemptId: photoAttemptId,
          stage: "retry_bootstrap",
          outcome: "success",
          startedAtMs: reconcileStartedAtMs,
        });
        return state;
      },
      (error) => {
        recordPhotoEvent({
          attemptId: photoAttemptId,
          stage: "retry_bootstrap",
          outcome: "failure",
          startedAtMs: reconcileStartedAtMs,
          error,
        });
        throw error;
      },
    );
    const latestMedication = latestState.medications.find(
      (item) => item.id === medicationId,
    );
    if (latestMedication) {
      this.setData({ expectedVersion: latestMedication.version });
    }
    const pending = this.data.photoResume;
    let remoteStatus = null;
    if (pending) {
      remoteStatus = await service.getMedicationPhotoStatus(
        medicationId,
        pending.ticket.mediaId,
        {
          attemptId: photoAttemptId,
          stage: "retry_bootstrap",
          transport: "relay",
        },
      );
      if (remoteStatus.status === "uploaded" && remoteStatus.fileId) {
        this.setData({
          photoResume: {
            ...pending,
            staged: {
              ticket: pending.ticket,
              fileId: remoteStatus.fileId,
            },
          },
        });
      }
    }
    const pendingMediaId = pending?.ticket.mediaId;
    const alreadyCommitted =
      Boolean(pendingMediaId) &&
      (remoteStatus?.status === "attached" ||
        latestMedication?.photo?.mediaId === pendingMediaId);
    const finalState = alreadyCommitted
      ? latestMedication?.photo?.mediaId === pendingMediaId
        ? latestState
        : await service.bootstrap()
      : await this.applyPhotoChange(
          { medicationId, state: latestState, planId: null },
          service,
          photoAttemptId,
        );
    if (alreadyCommitted) {
      recordPhotoEvent({
        attemptId: photoAttemptId,
        stage: "read_back",
        outcome: "success",
      });
      this.setData({ photoResume: null });
    }
    return finalState;
  },

  async retryPhoto() {
    if (this.data.saving || !this.data.medicationId) return;
    this.setData({ saving: true, saveError: "" });
    void wx.showLoading({ title: "重试照片", mask: true });
    try {
      const state = await this.resumePhotoChange(
        this.data.medicationId,
        getApp<IAppOption>().getService(),
        this.data.photoAttemptId,
      );
      const medication = state.medications.find(
        (item) => item.id === this.data.medicationId,
      );
      this.setData({
        expectedVersion: medication?.version ?? this.data.expectedVersion,
        photoSaveWarning: "",
        photoResume: null,
        photoChange: "unchanged",
        photoTempPath: "",
        originalPhotoUrl:
          medication?.photo?.url ?? medication?.photo?.fileId ?? "",
        photoPreview: medication?.photo?.url ?? medication?.photo?.fileId ?? "",
        formState: FORM_STATE.SAVED,
      });
      void wx.showToast({ title: "照片已保存", icon: "success" });
      const url = `/pages/medicine-detail/index?id=${this.data.medicationId}&saved=1`;
      await wx.redirectTo({ url }).catch(() => wx.navigateTo({ url }));
    } catch (error) {
      this.setData({
        photoSaveWarning:
          error instanceof Error ? error.message : "照片未完成，请稍后重试",
      });
      showError(error, "照片未完成，请稍后重试");
    } finally {
      void wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  async copyPhotoDiagnostic() {
    try {
      await wx.setClipboardData({
        data: photoAttemptReport(this.data.photoAttemptId),
      });
      void wx.showToast({ title: "已复制照片诊断", icon: "success" });
    } catch (error) {
      showError(error, "未能复制照片诊断");
    }
  },

  openPendingSaves() {
    void wx.navigateTo({ url: "/pages/sync/index" });
  },

  async saveDurably(draft: MedicationDraft) {
    const deadlineAt = Date.now() + SAVE_BUDGET_MS;
    const queue = getSaveQueue(getApp<IAppOption>().getService());
    this.setData({ saving: true, saveError: "" });
    void wx.showLoading({ title: "正在保存", mask: true });
    try {
      const job = this.data.pendingSaveId
        ? queue.list().find((item) => item.id === this.data.pendingSaveId)
        : queue.start(draft, this.data.photoTempPath, this.data.photoChange);
      if (!job) throw new Error("保存任务不存在，请到药箱核对");
      this.setData({ pendingSaveId: job.id, photoAttemptId: job.id });
      const result = await observeSave(
        queue.run(job.id, deadlineAt),
        deadlineAt,
      );
      void wx.hideLoading();
      this.setData({ saving: false });
      const current: SaveJob =
        result ?? queue.list().find((item) => item.id === job.id) ?? job;
      if (current.medicationId)
        this.setData({
          medicationId: current.medicationId,
          editing: true,
          expectedVersion: current.version ?? this.data.expectedVersion,
        });
      if (current.status === "ready") {
        this.setData({
          pendingSaveId: "",
          photoChange: "unchanged",
          photoTempPath: "",
          photoSaveWarning: "",
          formState: FORM_STATE.SAVED,
        });
        this.clearLeaveGuard();
        void wx.showToast({ title: "已保存", icon: "success" });
        const url = `/pages/medicine-detail/index?id=${current.medicationId}&saved=1`;
        try {
          await wx.redirectTo({ url });
        } catch {
          await wx.navigateTo({ url });
        }
      } else {
        this.setData({
          photoSaveWarning: `${saveJobView(current).message}。任务已保存在本机，可在待同步列表中继续。`,
          formState: FORM_STATE.SAVED,
        });
        this.clearLeaveGuard();
      }
    } catch (error) {
      this.setData({
        saveError:
          error instanceof Error ? error.message : "保存未完成，请重试",
      });
    } finally {
      void wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  async save() {
    if (this.data.saving || this.data.photoBusy) return;
    if (this.data.pendingSaveId) {
      await this.saveDurably(this.buildDraft());
      return;
    }
    if (
      this.data.photoSaveWarning &&
      this.data.formState === FORM_STATE.SAVED
    ) {
      await this.retryPhoto();
      return;
    }
    const draft = this.buildDraft();
    const validation = validateMedicationDraft(draft, { today: todayKey() });
    if (!validation.valid) {
      const firstField = Object.keys(validation.fieldErrors)[0] ?? "";
      const selector = ["name", "expiryValue", "profileId"].includes(firstField)
        ? "#essential-fields"
        : ["initialQuantityMilli", "openedDate", "afterOpenDays"].includes(
              firstField,
            )
          ? "#more-fields"
          : "#usage-fields";
      this.setData({
        fieldErrors: validation.fieldErrors,
        nameFocus: firstField === "name",
      });
      void wx.pageScrollTo({ selector, duration: 260 });
      void wx.showToast({
        title: Object.values(validation.fieldErrors)[0] ?? "请检查填写内容",
        icon: "none",
      });
      return;
    }
    const expiryDate = resolveExpiry(draft).effectiveExpiryDate;
    if (expiryDate < todayKey()) {
      const confirmResult = await wx.showModal({
        title: "这个药盒已超过管理期限",
        content: "可以继续保存用于核对；“今天”页不会把它作为普通可服任务。",
        cancelText: "返回修改",
        confirmText: "保存并标记到期",
        confirmColor: "#B63D3D",
      });
      if (!confirmResult.confirm) return;
    }

    this.clearLeaveGuard();
    const wasEditing = this.data.editing;
    this.setData({
      saving: true,
      saveError: "",
      photoSaveWarning: "",
      fieldErrors: {},
      formState: FORM_STATE.SAVING,
    });
    if (getApp<IAppOption>().getService().supportsDurableSaves) {
      await this.saveDurably(draft);
      return;
    }
    let result: SaveMedicationResult | null = null;
    const photoAttemptId =
      this.data.photoAttemptId ||
      (this.data.photoChange !== "unchanged" ? createPhotoAttempt() : "");
    if (photoAttemptId && !this.data.photoAttemptId)
      this.setData({ photoAttemptId });
    try {
      const service = getApp<IAppOption>().getService();
      void wx.showLoading({ title: "正在保存", mask: true });
      try {
        result = await service.saveMedication(draft);
        if (photoAttemptId)
          recordPhotoEvent({
            attemptId: photoAttemptId,
            stage: "save_fields",
            outcome: "success",
          });
      } catch (error) {
        if (photoAttemptId)
          recordPhotoEvent({
            attemptId: photoAttemptId,
            stage: "save_fields",
            outcome: "failure",
            error,
          });
        throw error;
      }
      const savedMedication = result.state.medications.find(
        (item) => item.id === result?.medicationId,
      );
      if (!savedMedication) {
        throw new ServiceError("NOT_FOUND", "已保存的药盒不存在");
      }
      // The fields are durable even if photo upload, a native dialog, or
      // navigation fails afterwards. Retain the ID/version so another save
      // updates this box instead of creating a duplicate or inventory entry.
      this.setData({
        medicationId: result.medicationId,
        expectedVersion: savedMedication.version,
        editing: true,
        quantityOpen: false,
        quantity: "",
        formState: FORM_STATE.SAVED,
      });

      let finalState = result.state;
      let photoError: unknown = null;
      try {
        finalState = await this.applyPhotoChange(
          result,
          service,
          photoAttemptId,
        );
      } catch (error) {
        photoError = error;
      }
      void wx.hideLoading();

      if (photoError) {
        const firstMessage =
          photoError instanceof Error ? photoError.message : "照片没有上传成功";
        const serviceLikeError =
          photoError instanceof ServiceError ||
          (Boolean(photoError) &&
            typeof photoError === "object" &&
            "code" in photoError &&
            "retryable" in photoError);
        const canRetry = serviceLikeError
          ? Boolean(
              (photoError as ServiceError).retryable ||
              ["CONFLICT", "VERSION_CONFLICT"].includes(
                (photoError as ServiceError).code,
              ),
            )
          : false;
        this.setData({ photoSaveWarning: firstMessage });
        const choice = await wx.showModal({
          title: "药盒已保存，照片未完成",
          content: `${firstMessage}。药名、有效期和计划已经安全保存。${canRetry ? "要现在重试照片吗？" : "可稍后从药盒详情进入编辑页补充照片。"}`,
          showCancel: canRetry,
          cancelText: "稍后再说",
          confirmText: canRetry ? "立即重试" : "知道了",
          confirmColor: "#167A50",
        });
        if (canRetry && choice.confirm) {
          void wx.showLoading({ title: "重试照片", mask: true });
          try {
            finalState = await this.resumePhotoChange(
              result.medicationId,
              service,
              photoAttemptId,
            );
            photoError = null;
          } catch (retryError) {
            photoError = retryError;
          } finally {
            void wx.hideLoading();
          }
          if (photoError) {
            const message =
              photoError instanceof Error
                ? photoError.message
                : "照片没有上传成功，可稍后在编辑页重试";
            this.setData({ photoSaveWarning: message });
            await wx.showModal({
              title: "照片稍后再补",
              content: `${message}。可从药盒详情进入编辑页再次添加。`,
              showCancel: false,
              confirmText: "知道了",
            });
          }
        }
      }

      const finalMedication = finalState.medications.find(
        (item) => item.id === result?.medicationId,
      );
      this.setData({
        expectedVersion: finalMedication?.version ?? savedMedication.version,
        formState: FORM_STATE.SAVED,
        ...(!photoError
          ? {
              photoChange: "unchanged",
              photoTempPath: "",
              originalPhotoUrl:
                finalMedication?.photo?.url ??
                finalMedication?.photo?.fileId ??
                "",
              photoPreview:
                finalMedication?.photo?.url ??
                finalMedication?.photo?.fileId ??
                "",
              photoSaveWarning: "",
            }
          : {}),
      });
      if (!photoError) {
        void wx.showToast({
          title: wasEditing ? "已保存" : "已添加到药箱",
          icon: "success",
        });
      }

      // Keep the selected file, upload ticket and diagnostic button reachable
      // until the photo succeeds or the user explicitly leaves the form.
      if (photoError) return;

      // Reminder permissions are configured separately from saving the box.
      const detailUrl = `/pages/medicine-detail/index?id=${result.medicationId}&saved=1`;
      try {
        await wx.redirectTo({ url: detailUrl });
      } catch {
        await wx.navigateTo({ url: detailUrl });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "操作没有完成，请稍后重试";
      const saveError = result
        ? "药盒信息已保存，后续操作未完成。可以返回药箱查看，不必重复添加。"
        : message;
      this.setData({
        formState: result ? FORM_STATE.SAVED : FORM_STATE.ERROR,
        saveError,
      });
      showError(new Error(saveError));
      if (!result) {
        try {
          wx.enableAlertBeforeUnload({
            message: "还有未保存的药盒信息，确定离开吗？",
          });
        } catch {
          // Older base libraries do not expose the leave guard API.
        }
      }
    } finally {
      void wx.hideLoading();
      this.setData({ saving: false });
    }
  },
});
