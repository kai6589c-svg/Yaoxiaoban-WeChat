import { clearInventorySession } from "./inventory-session";
import { buildTodayDashboard, type TodayDashboard } from "../core/dashboard";
import { cancelMedicationSync, clearAccountSync } from "./sync-lifecycle";
import {
  errorMetadata,
  recordDiagnostic,
  recordPhotoEvent,
  type PhotoRpcContext,
} from "./diagnostics";
import { RUNTIME_CONFIG } from "../config/runtime";
import { createDefaultProfile, createEmptyState } from "../core/defaults";
import { todayKey } from "../core/dates";
import { resolveExpiry } from "../core/expiry";
import { createId, createRequestId } from "../core/id";
import type {
  AccountSettings,
  AppState,
  CalendarExport,
  IntakeStatus,
  Medication,
  MedicationDraft,
  Profile,
  PlanVersion,
} from "../core/models";
import { expandOccurrences } from "../core/schedule";
import { clearLocalCalendarLedger } from "./calendar";
import { validateMedicationDraft, validateProfile } from "../core/validation";

const STORAGE_KEY = "yaoxiaoban_state_v1";
const PHOTO_ACTIONS = new Set([
  "saveMedicationFast",
  "uploadMedicationPhoto",
  "putMedicationPhotoChunk",
  "finishMedicationPhotoUpload",
  "completeMedicationPhotoUpload",
  "prepareMedicationPhoto",
  "commitMedicationPhoto",
  "removeMedicationPhoto",
  "discardMedicationPhoto",
  "getMedicationPhotoStatus",
]);
// wx.cloud.callFunction has no supported config.timeout. Allow the deployed
// function's 30-second execution window plus transport overhead, then release
// the form while retaining its request ID for an ambiguous write result.
const PHOTO_CALL_TIMEOUT_MS = 35_000;
const BOOTSTRAP_CALL_TIMEOUT_MS = 35_000;

class PreservedSdkError extends Error {
  constructor(public readonly original: unknown) {
    const message =
      typeof original === "object" && original !== null && "errMsg" in original
        ? String(original.errMsg)
        : original instanceof Error
          ? original.message
          : "照片请求未完成";
    super(message);
    this.name = "PreservedSdkError";
  }
}

const utf8ByteLength = (value: string): number => {
  try {
    return encodeURIComponent(value).replace(/%[A-F\d]{2}/g, "x").length;
  } catch {
    return value.length;
  }
};

function withPhotoCallTimeout<T>(
  request: Promise<T>,
  timeoutMs = PHOTO_CALL_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ServiceError(
            "MEDIA_UNAVAILABLE",
            "照片服务响应超时，请稍后重试",
            true,
            "unknown",
            {
              errCode: "CLIENT_PHOTO_CALL_TIMEOUT",
              errMsg: "photo call timeout",
            },
          ),
        ),
      timeoutMs,
    );
    request.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(new PreservedSdkError(error));
      },
    );
  });
}

function withBootstrapCallTimeout<T>(request: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ServiceError(
            "NETWORK",
            "服务响应超时，请稍后重试",
            true,
            "definite",
            {
              errCode: "CLIENT_BOOTSTRAP_TIMEOUT",
              errMsg: "bootstrap timeout",
            },
          ),
        ),
      BOOTSTRAP_CALL_TIMEOUT_MS,
    );
    request.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(new PreservedSdkError(error));
      },
    );
  });
}

export type ServiceErrorCode =
  | "VALIDATION"
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VERSION_CONFLICT"
  | "UNAUTHORIZED"
  | "UNAUTHENTICATED"
  | "ACCOUNT_UNAVAILABLE"
  | "FORBIDDEN"
  | "PAYLOAD_TOO_LARGE"
  | "LOCAL_FILE_MISSING"
  | "INVALID_MEDIA"
  | "INVALID_MEDIA_STATE"
  | "MEDIA_NOT_FOUND"
  | "MEDIA_UPLOAD_EXPIRED"
  | "MEDIA_UNAVAILABLE"
  | "NETWORK"
  | "LIMIT_EXCEEDED"
  | "PROFILE_IN_USE"
  | "LAST_PROFILE"
  | "MEDICATION_ARCHIVED"
  | "MEDICATION_DELETING"
  | "UNIT_MISMATCH"
  | "INVALID_SCHEDULE"
  | "EXPORT_TOO_LARGE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "OPERATION_IN_PROGRESS"
  | "INTERNAL"
  | "UNKNOWN";

export class ServiceError extends Error {
  public readonly retryable: boolean;
  public readonly userSafeMessage: string;

  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
    retryable = code === "NETWORK" || code === "MEDIA_UNAVAILABLE",
    public readonly outcome: "definite" | "unknown" = "definite",
    public readonly rawError?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
    this.retryable = retryable;
    this.userSafeMessage = message;
  }
}

export interface SaveMedicationResult {
  state: AppState;
  medicationId: string;
  planId: string | null;
  photoTicket?: MedicationPhotoUploadTicket;
}

export interface MedicationPhotoUploadTicket {
  mediaId: string;
  cloudPath: string;
  expiresAt: string;
  maxBytes: number;
  transport: "cloud" | "local";
  protocol?: "chunks-v2";
}

export interface MedicationPhotoStatus {
  mediaId: string;
  medicationId: string;
  status:
    | "prepared"
    | "uploading"
    | "uploaded"
    | "attached"
    | "cleanup_pending"
    | "expired";
  fileId: string | null;
  expiresAt: string | null;
  allowedActions?: string[];
}

export type ReminderKind = "dose" | "expiry" | "shortage";
export interface ReminderStatus {
  preferences: Record<ReminderKind, boolean>;
  grants: Record<ReminderKind, { accepted: boolean; usableCount: number }>;
  tasks: Array<{
    id: string;
    kind: ReminderKind;
    status: string;
    dueAt: string;
    sentAt: string | null;
    failureCode: string | null;
    attemptCount?: number;
    lastAttemptAt?: string | null;
    nextAttemptAt?: string | null;
  }>;
}

export interface CommitMedicationPhotoInput {
  medicationId: string;
  expectedVersion: number;
  mediaId: string;
  fileId: string;
}

export interface RecordIntakeInput {
  medicationId: string;
  planId: string | null;
  occurrenceKey: string | null;
  scheduledAt: string | null;
  status: IntakeStatus;
  quantityMilli: number;
  occurredAt?: string;
  requestId?: string;
}

export interface DataService {
  readonly supportsDurableSaves?: boolean;
  syncScope?: string;
  lastState?: AppState;
  bootstrap(): Promise<AppState>;
  getTodayDashboard?(): Promise<TodayDashboard>;
  processMedicationPhoto?(medicationId: string): Promise<void>;
  acceptPrivacy(version: string): Promise<AppState>;
  upsertProfile(input: {
    id?: string;
    name: string;
    relation: Profile["relation"];
    color: string;
    expectedVersion?: number;
  }): Promise<AppState>;
  archiveProfile(id: string, expectedVersion: number): Promise<AppState>;
  saveMedication(
    draft: MedicationDraft,
    context?: PhotoRpcContext,
  ): Promise<SaveMedicationResult>;
  archiveMedication(id: string, expectedVersion: number): Promise<AppState>;
  restoreMedication(id: string, expectedVersion: number): Promise<AppState>;
  deleteMedication(id: string, expectedVersion: number): Promise<AppState>;
  prepareMedicationPhoto(
    medicationId: string,
    expectedVersion: number,
    context?: PhotoRpcContext,
  ): Promise<MedicationPhotoUploadTicket>;
  uploadMedicationPhoto?(
    input: {
      medicationId: string;
      expectedVersion: number;
      mediaId: string;
      base64: string;
    },
    context?: PhotoRpcContext,
  ): Promise<{ fileId: string; completedState?: AppState }>;
  commitMedicationPhoto(
    input: CommitMedicationPhotoInput,
    context?: PhotoRpcContext,
  ): Promise<AppState>;
  removeMedicationPhoto(
    medicationId: string,
    expectedVersion: number,
    context?: PhotoRpcContext,
  ): Promise<AppState>;
  discardMedicationPhoto(
    mediaId: string,
    fileId: string | null,
    context?: PhotoRpcContext,
  ): Promise<void>;
  getMedicationPhotoStatus(
    medicationId: string,
    mediaId: string,
    context?: PhotoRpcContext,
  ): Promise<MedicationPhotoStatus>;
  recordSubscriptionGrant(
    kind: ReminderKind,
    templateId: string,
    status: "accept" | "reject",
    medicationId?: string,
  ): Promise<{ kind: ReminderKind; status: string; usableCount: number }>;
  getReminderStatus(medicationId?: string): Promise<ReminderStatus>;
  updateReminderSettings(
    kind: ReminderKind,
    enabled: boolean,
    leadDays?: number,
  ): Promise<AppState>;
  confirmInventory(input: {
    medicationId: string;
    quantityMilli: number;
    note?: string;
    recordedAt?: string;
    requestId?: string;
  }): Promise<AppState>;
  recordIntake(
    input: RecordIntakeInput,
    context?: PhotoRpcContext,
  ): Promise<AppState>;
  undoIntake(logId: string, expectedVersion: number): Promise<AppState>;
  saveCalendarExport(
    input: Omit<CalendarExport, "id" | "exportedAt" | "staleAt" | "version">,
  ): Promise<AppState>;
  updateSettings(patch: Partial<AccountSettings>): Promise<AppState>;
  exportData(): Promise<string>;
  deleteAccount(): Promise<void>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const nowIso = (): string => new Date().toISOString();

const removeLocalSavedFile = async (filePath: string | null): Promise<void> => {
  if (!filePath || filePath.startsWith("cloud://")) return;
  await new Promise<void>((resolve) => {
    wx.getFileSystemManager().removeSavedFile({
      filePath,
      success: () => resolve(),
      fail: () => resolve(),
    });
  });
};

const parseStoredState = (value: unknown): AppState | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AppState>;
  if (
    candidate.schemaVersion !== 1 ||
    !candidate.settings ||
    !Array.isArray(candidate.profiles) ||
    !Array.isArray(candidate.medications) ||
    !Array.isArray(candidate.plans) ||
    !Array.isArray(candidate.snapshots) ||
    !Array.isArray(candidate.intakeLogs) ||
    !Array.isArray(candidate.calendarExports)
  ) {
    return null;
  }
  const state = candidate as AppState;
  return {
    ...state,
    medications: state.medications.map((item) => ({
      ...item,
      photo: item.photo ?? null,
    })),
  };
};

const sortedNumbers = (values: readonly number[]): number[] =>
  [...values].sort((a, b) => a - b);

const sortedStrings = (values: readonly string[]): string[] =>
  [...values].sort();

const sameActivePlan = (
  plan: PlanVersion | undefined,
  draft: MedicationDraft,
  currentUnit: string,
): boolean => {
  if (draft.mode === "expiry_only" || !draft.schedule) return !plan;
  if (!plan || currentUnit !== draft.unit) return false;
  return (
    plan.scheduleType === draft.schedule.type &&
    plan.startDate === draft.schedule.startDate &&
    plan.endDate === draft.schedule.endDate &&
    plan.doseMilli === draft.schedule.doseMilli &&
    JSON.stringify(sortedNumbers(plan.weekdays)) ===
      JSON.stringify(sortedNumbers(draft.schedule.weekdays)) &&
    JSON.stringify(sortedStrings(plan.times)) ===
      JSON.stringify(sortedStrings(draft.schedule.times))
  );
};

class LocalDataService implements DataService {
  private state: AppState | null = null;
  private readonly localPhotoTickets = new Map<
    string,
    { medicationId: string; expectedVersion: number; expiresAt: string }
  >();

  async getTodayDashboard(): Promise<TodayDashboard> {
    return buildTodayDashboard(await this.bootstrap());
  }
  async bootstrap(): Promise<AppState> {
    if (!this.state) {
      const stored = parseStoredState(wx.getStorageSync<unknown>(STORAGE_KEY));
      this.state = stored ?? createEmptyState(nowIso());
    }
    return clone(this.state);
  }

  private async commit(mutator: (state: AppState) => void): Promise<AppState> {
    const state = await this.bootstrap();
    mutator(state);
    state.updatedAt = nowIso();
    this.state = state;
    wx.setStorageSync(STORAGE_KEY, state);
    return clone(state);
  }

  async acceptPrivacy(version: string): Promise<AppState> {
    return this.commit((state) => {
      state.settings.privacyAcceptedVersion = version;
      state.settings.privacyAcceptedAt = nowIso();
      if (!state.profiles.some((profile) => !profile.archivedAt)) {
        state.profiles.push(
          createDefaultProfile(nowIso(), createId("profile")),
        );
      }
    });
  }

  async upsertProfile(input: {
    id?: string;
    name: string;
    relation: Profile["relation"];
    color: string;
    expectedVersion?: number;
  }): Promise<AppState> {
    const validation = validateProfile(input);
    if (!validation.valid) {
      throw new ServiceError(
        "VALIDATION",
        Object.values(validation.fieldErrors)[0] ?? "成员信息不完整",
      );
    }
    return this.commit((state) => {
      const current = input.id
        ? state.profiles.find((item) => item.id === input.id)
        : undefined;
      if (input.id && !current)
        throw new ServiceError("NOT_FOUND", "成员不存在");
      if (current) {
        if (input.expectedVersion !== current.version) {
          throw new ServiceError(
            "CONFLICT",
            "成员资料已在其他设备更新，请刷新后重试",
          );
        }
        current.name = input.name.trim();
        current.relation = input.relation;
        current.color = input.color;
        current.updatedAt = nowIso();
        current.version += 1;
      } else {
        const timestamp = nowIso();
        state.profiles.push({
          id: createId("profile"),
          name: input.name.trim(),
          relation: input.relation,
          color: input.color,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1,
        });
      }
    });
  }

  async archiveProfile(id: string, expectedVersion: number): Promise<AppState> {
    return this.commit((state) => {
      const profile = state.profiles.find((item) => item.id === id);
      if (!profile) throw new ServiceError("NOT_FOUND", "成员不存在");
      if (profile.version !== expectedVersion)
        throw new ServiceError("CONFLICT", "资料已更新，请刷新后重试");
      const activeProfiles = state.profiles.filter((item) => !item.archivedAt);
      if (activeProfiles.length <= 1)
        throw new ServiceError("VALIDATION", "至少保留一位成员");
      if (
        state.medications.some(
          (item) => item.profileId === id && !item.archivedAt,
        )
      ) {
        throw new ServiceError("VALIDATION", "请先移除该成员名下的药品");
      }
      profile.archivedAt = nowIso();
      profile.updatedAt = nowIso();
      profile.version += 1;
    });
  }

  async saveMedication(draft: MedicationDraft): Promise<SaveMedicationResult> {
    const validation = validateMedicationDraft(draft, { today: todayKey() });
    if (!validation.valid) {
      throw new ServiceError(
        "VALIDATION",
        Object.values(validation.fieldErrors)[0] ?? "药品信息不完整",
      );
    }
    let medicationId = draft.id ?? createId("med");
    let planId: string | null = null;
    const state = await this.commit((next) => {
      if (
        !next.profiles.some(
          (profile) => profile.id === draft.profileId && !profile.archivedAt,
        )
      ) {
        throw new ServiceError("NOT_FOUND", "所选成员不存在");
      }
      const timestamp = nowIso();
      const current = draft.id
        ? next.medications.find((item) => item.id === draft.id)
        : undefined;
      let calendarMetadataChanged = false;
      if (draft.id && !current)
        throw new ServiceError("NOT_FOUND", "药品不存在");
      if (current) {
        const previousName = current.name;
        const previousEffectiveExpiry =
          resolveExpiry(current).effectiveExpiryDate;
        if (current.version !== draft.expectedVersion) {
          throw new ServiceError(
            "CONFLICT",
            "药品已在其他设备更新，请刷新后重试",
          );
        }
        if (
          current.unit !== draft.unit &&
          (next.snapshots.some((item) => item.medicationId === current.id) ||
            next.intakeLogs.some((item) => item.medicationId === current.id) ||
            next.plans.some((item) => item.medicationId === current.id))
        ) {
          throw new ServiceError(
            "VALIDATION",
            "已有计划、盘点或使用记录，不能直接修改单位；请新建另一盒",
          );
        }
        medicationId = current.id;
        Object.assign(current, {
          profileId: draft.profileId,
          name: draft.name.trim(),
          specification: draft.specification.trim(),
          ...(draft.storageLocation !== undefined
            ? { storageLocation: draft.storageLocation.trim() }
            : {}),
          unit: draft.unit.trim(),
          mode: draft.mode,
          expiryPrecision: draft.expiryPrecision,
          expiryValue: draft.expiryValue,
          openedDate: draft.openedDate,
          afterOpenDays: draft.afterOpenDays,
          note: draft.note.trim(),
          updatedAt: timestamp,
          version: current.version + 1,
        } satisfies Partial<Medication>);
        calendarMetadataChanged =
          previousEffectiveExpiry !==
            resolveExpiry(current).effectiveExpiryDate ||
          (next.settings.notificationPrivacy === "detailed" &&
            previousName !== current.name);
      } else {
        next.medications.push({
          id: medicationId,
          profileId: draft.profileId,
          name: draft.name.trim(),
          specification: draft.specification.trim(),
          ...(draft.storageLocation !== undefined
            ? { storageLocation: draft.storageLocation.trim() }
            : {}),
          unit: draft.unit.trim(),
          mode: draft.mode,
          expiryPrecision: draft.expiryPrecision,
          expiryValue: draft.expiryValue,
          openedDate: draft.openedDate,
          afterOpenDays: draft.afterOpenDays,
          note: draft.note.trim(),
          photo: null,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1,
        });
      }

      const activePlans = next.plans.filter(
        (plan) =>
          plan.medicationId === medicationId && plan.effectiveTo === null,
      );
      const planUnchanged =
        activePlans.length <= 1 &&
        sameActivePlan(activePlans[0], draft, current?.unit ?? draft.unit);
      const planChanged = !planUnchanged;
      if (planChanged) {
        for (const plan of activePlans) {
          plan.effectiveTo = timestamp;
          plan.version += 1;
        }
      }
      if (activePlans.length && (planChanged || calendarMetadataChanged)) {
        for (const calendarExport of next.calendarExports) {
          if (
            calendarExport.medicationId === medicationId &&
            !calendarExport.staleAt
          ) {
            calendarExport.staleAt = timestamp;
            calendarExport.version += 1;
          }
        }
      }

      if (planChanged && draft.mode !== "expiry_only" && draft.schedule) {
        planId = createId("plan");
        next.plans.push({
          id: planId,
          medicationId,
          scheduleType: draft.schedule.type,
          startDate: draft.schedule.startDate,
          endDate: draft.schedule.endDate,
          weekdays: [...draft.schedule.weekdays].sort((a, b) => a - b),
          times: [...draft.schedule.times].sort(),
          doseMilli: draft.schedule.doseMilli,
          effectiveFrom: timestamp,
          effectiveTo: null,
          createdAt: timestamp,
          version: 1,
        });
      }

      if (
        draft.initialQuantityMilli !== null &&
        draft.initialQuantityMilli !== undefined
      ) {
        next.snapshots.push({
          id: createId("snapshot"),
          medicationId,
          quantityMilli: draft.initialQuantityMilli,
          recordedAt: timestamp,
          note: current ? "编辑药品时重新盘点" : "首次添加",
          createdAt: timestamp,
          version: 1,
        });
      }
    });
    return { state, medicationId, planId };
  }

  async archiveMedication(
    id: string,
    expectedVersion: number,
  ): Promise<AppState> {
    return this.commit((state) => {
      const medication = state.medications.find((item) => item.id === id);
      if (!medication) throw new ServiceError("NOT_FOUND", "药品不存在");
      if (medication.version !== expectedVersion)
        throw new ServiceError("CONFLICT", "药品已更新，请刷新后重试");
      const timestamp = nowIso();
      medication.archivedAt = timestamp;
      medication.updatedAt = timestamp;
      medication.version += 1;
      for (const plan of state.plans) {
        if (plan.medicationId === id && !plan.effectiveTo) {
          plan.effectiveTo = timestamp;
          plan.version += 1;
        }
      }
      for (const item of state.calendarExports) {
        if (item.medicationId === id && !item.staleAt) {
          item.staleAt = timestamp;
          item.version += 1;
        }
      }
    });
  }

  async restoreMedication(
    id: string,
    expectedVersion: number,
  ): Promise<AppState> {
    return this.commit((state) => {
      const medication = state.medications.find((item) => item.id === id);
      if (!medication || !medication.archivedAt)
        throw new ServiceError("NOT_FOUND", "已移除的药盒不存在");
      if (medication.version !== expectedVersion)
        throw new ServiceError("CONFLICT", "药盒已更新，请刷新后重试");
      medication.archivedAt = null;
      medication.mode = "expiry_only";
      medication.updatedAt = nowIso();
      medication.version += 1;
    });
  }

  async deleteMedication(
    id: string,
    expectedVersion: number,
  ): Promise<AppState> {
    const current = (await this.bootstrap()).medications.find(
      (item) => item.id === id,
    );
    const state = await this.commit((state) => {
      const medication = state.medications.find((item) => item.id === id);
      if (!medication) throw new ServiceError("NOT_FOUND", "药盒不存在");
      if (medication.version !== expectedVersion)
        throw new ServiceError("CONFLICT", "药盒已更新，请刷新后重试");
      state.medications = state.medications.filter((item) => item.id !== id);
      state.plans = state.plans.filter((item) => item.medicationId !== id);
      state.snapshots = state.snapshots.filter(
        (item) => item.medicationId !== id,
      );
      state.intakeLogs = state.intakeLogs.filter(
        (item) => item.medicationId !== id,
      );
      state.calendarExports = state.calendarExports.filter(
        (item) => item.medicationId !== id,
      );
    });
    await removeLocalSavedFile(current?.photo?.fileId ?? null);
    return state;
  }

  async prepareMedicationPhoto(
    medicationId: string,
    expectedVersion: number,
  ): Promise<MedicationPhotoUploadTicket> {
    const medication = (await this.bootstrap()).medications.find(
      (item) => item.id === medicationId && !item.archivedAt,
    );
    if (!medication) throw new ServiceError("NOT_FOUND", "药盒不存在");
    if (medication.version !== expectedVersion) {
      throw new ServiceError(
        "VERSION_CONFLICT",
        "药盒已在其他设备更新，请刷新后重试",
      );
    }
    const mediaId = createId("media");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    this.localPhotoTickets.set(mediaId, {
      medicationId,
      expectedVersion,
      expiresAt,
    });
    return {
      mediaId,
      cloudPath: "",
      expiresAt,
      maxBytes: 2 * 1024 * 1024,
      transport: "local",
    };
  }

  async commitMedicationPhoto(
    input: CommitMedicationPhotoInput,
  ): Promise<AppState> {
    const ticket = this.localPhotoTickets.get(input.mediaId);
    if (
      !ticket ||
      ticket.medicationId !== input.medicationId ||
      ticket.expectedVersion !== input.expectedVersion ||
      Date.parse(ticket.expiresAt) <= Date.now() ||
      !input.fileId ||
      input.fileId.startsWith("cloud://")
    ) {
      throw new ServiceError(
        "INVALID_MEDIA",
        "照片上传任务无效或已经过期，请重新选择",
      );
    }
    let previousFileId: string | null = null;
    const state = await this.commit((next) => {
      const medication = next.medications.find(
        (item) => item.id === input.medicationId && !item.archivedAt,
      );
      if (!medication) throw new ServiceError("NOT_FOUND", "药盒不存在");
      if (medication.version !== input.expectedVersion) {
        throw new ServiceError(
          "VERSION_CONFLICT",
          "药盒已在其他设备更新，请刷新后重试",
        );
      }
      previousFileId = medication.photo?.fileId ?? null;
      const timestamp = nowIso();
      medication.photo = {
        mediaId: input.mediaId,
        fileId: input.fileId,
        updatedAt: timestamp,
      };
      medication.updatedAt = timestamp;
      medication.version += 1;
    });
    if (previousFileId && previousFileId !== input.fileId) {
      await removeLocalSavedFile(previousFileId);
    }
    this.localPhotoTickets.delete(input.mediaId);
    return state;
  }

  async removeMedicationPhoto(
    medicationId: string,
    expectedVersion: number,
  ): Promise<AppState> {
    let previousFileId: string | null = null;
    const state = await this.commit((next) => {
      const medication = next.medications.find(
        (item) => item.id === medicationId,
      );
      if (!medication) throw new ServiceError("NOT_FOUND", "药盒不存在");
      if (medication.version !== expectedVersion) {
        throw new ServiceError(
          "VERSION_CONFLICT",
          "药盒已在其他设备更新，请刷新后重试",
        );
      }
      if (!medication.photo) return;
      previousFileId = medication.photo.fileId ?? null;
      medication.photo = null;
      medication.updatedAt = nowIso();
      medication.version += 1;
    });
    await removeLocalSavedFile(previousFileId);
    return state;
  }

  async discardMedicationPhoto(
    mediaId: string,
    fileId: string | null,
  ): Promise<void> {
    if (!this.localPhotoTickets.has(mediaId)) return;
    this.localPhotoTickets.delete(mediaId);
    await removeLocalSavedFile(fileId);
  }

  async getMedicationPhotoStatus(
    medicationId: string,
    mediaId: string,
  ): Promise<MedicationPhotoStatus> {
    const medication = (await this.bootstrap()).medications.find(
      (item) => item.id === medicationId,
    );
    const ticket = this.localPhotoTickets.get(mediaId);
    if (medication?.photo?.mediaId === mediaId) {
      return {
        mediaId,
        medicationId,
        status: "attached",
        fileId: medication.photo.fileId ?? null,
        expiresAt: null,
      };
    }
    if (!ticket) {
      return {
        mediaId,
        medicationId,
        status: "expired",
        fileId: null,
        expiresAt: null,
      };
    }
    return {
      mediaId,
      medicationId,
      status:
        Date.parse(ticket.expiresAt) <= Date.now() ? "expired" : "prepared",
      fileId: null,
      expiresAt: ticket.expiresAt,
    };
  }

  async recordSubscriptionGrant(
    kind: ReminderKind,
    templateId: string,
    status: "accept" | "reject",
    medicationId?: string,
  ) {
    return {
      kind,
      status,
      usableCount: status === "accept" ? 1 : 0,
      ...(medicationId ? { medicationId } : {}),
    };
  }

  async getReminderStatus(): Promise<ReminderStatus> {
    return {
      preferences: { dose: false, expiry: false, shortage: false },
      grants: {
        dose: { accepted: false, usableCount: 0 },
        expiry: { accepted: false, usableCount: 0 },
        shortage: { accepted: false, usableCount: 0 },
      },
      tasks: [],
    };
  }

  async updateReminderSettings(
    kind: ReminderKind,
    enabled: boolean,
    leadDays?: number,
  ): Promise<AppState> {
    return this.updateSettings({
      lowFrequencyReminders: enabled,
      ...(kind === "expiry" && leadDays !== undefined
        ? { expiryLeadDays: leadDays }
        : {}),
      ...(kind === "shortage" && leadDays !== undefined
        ? { lowStockLeadDays: leadDays }
        : {}),
    });
  }

  async confirmInventory(input: {
    medicationId: string;
    quantityMilli: number;
    note?: string;
    recordedAt?: string;
    requestId?: string;
  }): Promise<AppState> {
    if (!Number.isInteger(input.quantityMilli) || input.quantityMilli < 0) {
      throw new ServiceError("VALIDATION", "盘点数量不能小于0");
    }
    return this.commit((state) => {
      if (
        !state.medications.some(
          (item) => item.id === input.medicationId && !item.archivedAt,
        )
      ) {
        throw new ServiceError("NOT_FOUND", "药品不存在");
      }
      const requestId = input.requestId ?? createRequestId();
      if (state.snapshots.some((item) => item.id === requestId)) return;
      const timestamp = nowIso();
      state.snapshots.push({
        id: requestId,
        medicationId: input.medicationId,
        quantityMilli: input.quantityMilli,
        recordedAt: input.recordedAt ?? timestamp,
        note: input.note?.trim() ?? "手动盘点",
        createdAt: timestamp,
        version: 1,
      });
    });
  }

  async recordIntake(input: RecordIntakeInput): Promise<AppState> {
    if (!Number.isInteger(input.quantityMilli) || input.quantityMilli <= 0) {
      throw new ServiceError("VALIDATION", "记录数量必须大于0");
    }
    return this.commit((state) => {
      const medication = state.medications.find(
        (item) => item.id === input.medicationId && !item.archivedAt,
      );
      if (!medication) {
        throw new ServiceError("NOT_FOUND", "药品不存在");
      }
      const nowMs = Date.now();
      const occurredAtMs = input.occurredAt
        ? Date.parse(input.occurredAt)
        : nowMs;
      if (!Number.isFinite(occurredAtMs) || occurredAtMs > nowMs + 5 * 60_000) {
        throw new ServiceError("VALIDATION", "记录时间不能晚于当前时间");
      }
      let quantityMilli = input.quantityMilli;
      if (input.status !== "extra") {
        const plan = input.planId
          ? state.plans.find((item) => item.id === input.planId)
          : undefined;
        if (
          !plan ||
          plan.medicationId !== medication.id ||
          !input.scheduledAt
        ) {
          throw new ServiceError("VALIDATION", "服药任务不属于这个药盒");
        }
        const scheduledAtMs = Date.parse(input.scheduledAt);
        if (
          !Number.isFinite(scheduledAtMs) ||
          scheduledAtMs > nowMs + 10 * 60_000
        ) {
          throw new ServiceError("VALIDATION", "距计划时间10分钟内才能记录");
        }
        const expected = expandOccurrences(
          [plan],
          scheduledAtMs,
          scheduledAtMs,
          medication.id,
        )[0];
        if (!expected || expected.scheduledAt !== input.scheduledAt) {
          throw new ServiceError("VALIDATION", "这个服药任务已失效，请刷新");
        }
        quantityMilli = plan.doseMilli;
      }
      const requestId = input.requestId ?? createRequestId();
      if (state.intakeLogs.some((log) => log.requestId === requestId)) return;
      const existing = input.occurrenceKey
        ? state.intakeLogs.find(
            (log) => log.occurrenceKey === input.occurrenceKey && !log.voidedAt,
          )
        : undefined;
      const timestamp = nowIso();
      if (existing) {
        existing.status = input.status;
        existing.quantityMilli = quantityMilli;
        existing.occurredAt = input.occurredAt ?? timestamp;
        existing.requestId = requestId;
        existing.version += 1;
      } else {
        state.intakeLogs.push({
          id: createId("log"),
          medicationId: input.medicationId,
          planId: input.planId,
          occurrenceKey: input.occurrenceKey,
          status: input.status,
          quantityMilli,
          scheduledAt: input.scheduledAt,
          occurredAt: input.occurredAt ?? timestamp,
          requestId,
          voidedAt: null,
          createdAt: timestamp,
          version: 1,
        });
      }
    });
  }

  async undoIntake(logId: string, expectedVersion: number): Promise<AppState> {
    return this.commit((state) => {
      const log = state.intakeLogs.find((item) => item.id === logId);
      if (!log) throw new ServiceError("NOT_FOUND", "服药记录不存在");
      if (log.version !== expectedVersion)
        throw new ServiceError("CONFLICT", "记录已更新，请刷新后重试");
      log.voidedAt = nowIso();
      log.version += 1;
    });
  }

  async saveCalendarExport(
    input: Omit<CalendarExport, "id" | "exportedAt" | "staleAt" | "version">,
  ): Promise<AppState> {
    return this.commit((state) => {
      if (
        state.calendarExports.some(
          (item) => item.fingerprint === input.fingerprint && !item.staleAt,
        )
      ) {
        return;
      }
      state.calendarExports.push({
        ...input,
        id: createId("calendar"),
        exportedAt: nowIso(),
        staleAt: null,
        version: 1,
      });
    });
  }

  async updateSettings(patch: Partial<AccountSettings>): Promise<AppState> {
    return this.commit((state) => {
      if (
        patch.expiryLeadDays !== undefined &&
        ![7, 30, 90].includes(patch.expiryLeadDays)
      ) {
        throw new ServiceError("VALIDATION", "到期提醒天数不支持");
      }
      if (
        patch.lowStockLeadDays !== undefined &&
        ![3, 7, 14].includes(patch.lowStockLeadDays)
      ) {
        throw new ServiceError("VALIDATION", "余量提醒天数不支持");
      }
      if (
        patch.notificationPrivacy !== undefined &&
        !["generic", "detailed"].includes(patch.notificationPrivacy)
      ) {
        throw new ServiceError("VALIDATION", "日历隐私显示方式不支持");
      }
      if (
        patch.notificationPrivacy !== undefined &&
        patch.notificationPrivacy !== state.settings.notificationPrivacy
      ) {
        const timestamp = nowIso();
        for (const calendarExport of state.calendarExports) {
          if (!calendarExport.staleAt) {
            calendarExport.staleAt = timestamp;
            calendarExport.version += 1;
          }
        }
      }
      state.settings = {
        ...state.settings,
        ...patch,
        timezone: "Asia/Shanghai",
      };
    });
  }

  async exportData(): Promise<string> {
    const state = await this.bootstrap();
    const exportState = {
      ...state,
      medications: state.medications.map((item) => ({
        ...item,
        photo: item.photo
          ? {
              included: false,
              updatedAt: item.photo.updatedAt,
              notice: "照片文件与内部存储地址不写入剪贴板导出",
            }
          : null,
      })),
    };
    return JSON.stringify(
      {
        app: "药小伴",
        exportedAt: nowIso(),
        notice: "本文件包含私人服药记录，请妥善保管。",
        data: exportState,
      },
      null,
      2,
    );
  }

  async deleteAccount(): Promise<void> {
    const state = await this.bootstrap();
    await Promise.all(
      state.medications.map((item) =>
        removeLocalSavedFile(item.photo?.fileId ?? null),
      ),
    );
    this.state = createEmptyState(nowIso());
    wx.removeStorageSync(STORAGE_KEY);
    clearInventorySession(this);
    clearLocalCalendarLedger();
  }
}

class CloudDataService implements DataService {
  readonly supportsDurableSaves = true;
  syncScope?: string;
  lastState?: AppState;
  private readonly pendingRequestIds = new Map<string, string>();

  private async call<T>(
    action: string,
    payload: Record<string, unknown> = {},
    photoContext?: PhotoRpcContext,
  ): Promise<T> {
    const isWrite = ![
      "bootstrap",
      "getTodayDashboard",
      "exportData",
      "getMedicationPhotoStatus",
      "getReminderStatus",
    ].includes(action);
    const isPhotoAction = PHOTO_ACTIONS.has(action);
    let receivedResponse = false;
    const requestKey = `${action}:${JSON.stringify(payload)}`;
    const requestId = isWrite
      ? (photoContext?.requestId ??
        (typeof payload["requestId"] === "string"
          ? payload["requestId"]
          : undefined) ??
        this.pendingRequestIds.get(requestKey) ??
        createRequestId())
      : createRequestId();
    if (isWrite) this.pendingRequestIds.set(requestKey, requestId);
    const startedAtMs = Date.now();
    let photoEventRecorded = false;
    if (isPhotoAction && photoContext) {
      const event = JSON.stringify({
        action,
        payload,
        requestId,
        privacyVersion: RUNTIME_CONFIG.privacyVersion,
      });
      recordPhotoEvent({
        ...photoContext,
        requestId,
        outcome: "start",
        startedAtMs,
        eventUtf8Bytes: utf8ByteLength(event),
      });
    }
    try {
      if (photoContext?.deadlineAt && Date.now() >= photoContext.deadlineAt)
        throw new ServiceError(
          "NETWORK",
          "保存时间已到，请稍后继续同步",
          true,
          "unknown",
        );
      const call = wx.cloud.callFunction({
        name: "medicine-api",
        data: {
          action,
          payload,
          requestId,
          privacyVersion: RUNTIME_CONFIG.privacyVersion,
        },
      });
      const response = await (photoContext?.deadlineAt
        ? withPhotoCallTimeout(
            call,
            Math.max(1, photoContext.deadlineAt - Date.now()),
          )
        : isPhotoAction
          ? withPhotoCallTimeout(call)
          : action === "bootstrap"
            ? withBootstrapCallTimeout(call)
            : call);
      receivedResponse = true;
      const result = response.result as
        | { ok: true; data: T }
        | {
            ok: false;
            error: {
              code: ServiceError["code"];
              message: string;
            };
          };
      if (!result || !result.ok) {
        const error = result?.error;
        if (isPhotoAction && photoContext) {
          const metadata = errorMetadata(error);
          recordPhotoEvent({
            ...photoContext,
            requestId,
            outcome:
              error?.code === "OPERATION_IN_PROGRESS" ? "unknown" : "failure",
            elapsedMs: Date.now() - startedAtMs,
            error: error ?? new Error("PHOTO_EMPTY_SERVICE_ERROR"),
            errorCode: metadata.errorCode,
            errorCategory: metadata.errorCategory,
            sanitizedErrMsg: metadata.sanitizedErrMsg,
            cloudTraceId:
              typeof (error as { traceId?: unknown } | undefined)?.traceId ===
              "string"
                ? (error as unknown as { traceId: string }).traceId
                : undefined,
          });
          photoEventRecorded = true;
        }
        if (isWrite && error?.code === "OPERATION_IN_PROGRESS") {
          throw new ServiceError(
            error.code,
            "照片仍在处理中，请稍后重试",
            true,
            "unknown",
            error,
          );
        }
        if (isPhotoAction && /action\s*不受支持/i.test(error?.message ?? "")) {
          // An older deployed function can save medication fields while
          // lacking the photo protocol. Retrying cannot repair that mismatch.
          throw new ServiceError(
            "MEDIA_UNAVAILABLE",
            "照片服务尚未更新，暂时无法保存照片，请稍后再试",
            false,
            "definite",
            error,
          );
        }
        if (
          isPhotoAction &&
          (!error || ["UNKNOWN", "INTERNAL"].includes(error.code))
        ) {
          throw new ServiceError(
            "MEDIA_UNAVAILABLE",
            "照片服务暂时不可用，请稍后重试",
            true,
            "definite",
            error,
          );
        }
        throw new ServiceError(
          error?.code ?? "UNKNOWN",
          error?.message ?? "服务暂时不可用",
          error?.code === "NETWORK" || error?.code === "MEDIA_UNAVAILABLE",
          "definite",
          error,
        );
      }
      if (isPhotoAction && photoContext) {
        const responseMeta = response as unknown as {
          requestId?: unknown;
          backendBuild?: unknown;
        };
        recordPhotoEvent({
          ...photoContext,
          requestId,
          outcome: "success",
          elapsedMs: Date.now() - startedAtMs,
          platformRequestId:
            typeof responseMeta.requestId === "string"
              ? responseMeta.requestId
              : undefined,
          backendBuild:
            typeof responseMeta.backendBuild === "string"
              ? responseMeta.backendBuild
              : undefined,
        });
        photoEventRecorded = true;
      }
      if (isWrite) this.pendingRequestIds.delete(requestKey);
      const data = result.data as T & Partial<AppState> & { state?: AppState };
      const state =
        data?.schemaVersion === 1 ? (data as AppState) : data?.state;
      if (state) {
        this.lastState = state;
        if (state.syncScope) this.syncScope = state.syncScope;
      }
      return result.data;
    } catch (error) {
      const rawError =
        error instanceof ServiceError
          ? (error.rawError ?? error)
          : error instanceof PreservedSdkError
            ? error.original
            : error;
      const metadata = errorMetadata(rawError);
      const outcome = isWrite && !receivedResponse ? "unknown" : "failure";
      if (isPhotoAction && photoContext && !photoEventRecorded) {
        recordPhotoEvent({
          ...photoContext,
          requestId,
          outcome,
          elapsedMs: Date.now() - startedAtMs,
          error: rawError,
          errorCode: metadata.errorCode,
          errorCategory: metadata.errorCategory,
          sanitizedErrMsg: metadata.sanitizedErrMsg,
          cloudTraceId:
            typeof (error as { cloudTraceId?: unknown })?.cloudTraceId ===
            "string"
              ? (error as { cloudTraceId: string }).cloudTraceId
              : undefined,
        });
      }
      recordDiagnostic(
        action,
        error instanceof ServiceError ? error.code : "NETWORK_OR_RUNTIME",
        requestId,
        { cleanup: action === "discardMedicationPhoto" },
      );
      if (error instanceof ServiceError) {
        if (
          isWrite &&
          error.code !== "NETWORK" &&
          (!isPhotoAction || (receivedResponse && error.outcome !== "unknown"))
        )
          this.pendingRequestIds.delete(requestKey);
        throw error;
      }
      if (isPhotoAction) {
        const message =
          typeof rawError === "object" &&
          rawError !== null &&
          "errMsg" in rawError
            ? String(rawError.errMsg)
            : rawError instanceof Error
              ? rawError.message
              : "";
        if (/timeout|timed\s*out/i.test(message)) {
          throw new ServiceError(
            "MEDIA_UNAVAILABLE",
            "照片服务响应超时，请稍后重试",
            true,
            "unknown",
            rawError,
          );
        }
        if (
          /FUNCTIONS_EXECUTE|cloud function execution|SYSTEM_ERROR/i.test(
            message,
          )
        ) {
          throw new ServiceError(
            "MEDIA_UNAVAILABLE",
            "照片服务暂时不可用，请稍后重试",
            true,
            outcome === "unknown" ? "unknown" : "definite",
            rawError,
          );
        }
      }
      const message =
        typeof rawError === "object" &&
        rawError !== null &&
        "errMsg" in rawError
          ? String(rawError.errMsg)
          : rawError instanceof Error
            ? rawError.message
            : "";
      if (
        /FUNCTIONS_EXECUTE|cloud function execution|SYSTEM_ERROR|504002/i.test(
          message,
        )
      ) {
        throw new ServiceError(
          "ACCOUNT_UNAVAILABLE",
          "服务暂时不可用，请稍后重试",
          true,
          outcome === "unknown" ? "unknown" : "definite",
          rawError,
        );
      }
      throw new ServiceError(
        "NETWORK",
        "网络连接失败，请稍后重试",
        true,
        outcome === "unknown" ? "unknown" : "definite",
        rawError,
      );
    }
  }

  async processMedicationPhoto(medicationId: string): Promise<void> {
    await this.call("processMedicationPhoto", { medicationId });
  }
  async getTodayDashboard(): Promise<TodayDashboard> {
    const board = await this.call<TodayDashboard>("getTodayDashboard");
    if (board.syncScope) this.syncScope = board.syncScope;
    return board;
  }
  bootstrap(): Promise<AppState> {
    return this.call("bootstrap");
  }
  acceptPrivacy(version: string): Promise<AppState> {
    return this.call("acceptPrivacy", { version });
  }
  upsertProfile(
    input: Parameters<DataService["upsertProfile"]>[0],
  ): Promise<AppState> {
    return this.call("upsertProfile", input);
  }
  archiveProfile(id: string, expectedVersion: number): Promise<AppState> {
    return this.call("archiveProfile", { id, expectedVersion });
  }
  async saveMedication(
    draft: MedicationDraft,
    context?: PhotoRpcContext,
  ): Promise<SaveMedicationResult> {
    if (context) {
      const result = await this.call<{
        medication: Medication;
        planId: string | null;
        photoTicket?: MedicationPhotoUploadTicket;
      }>(
        "saveMedicationFast",
        { ...draft, preparePhoto: context.preparePhoto ?? false },
        context,
      );
      const current = this.lastState ?? createEmptyState(nowIso());
      const medications = current.medications.filter(
        (item) => item.id !== result.medication.id,
      );
      this.lastState = {
        ...current,
        medications: [...medications, result.medication],
        updatedAt: result.medication.updatedAt,
      };
      return {
        state: this.lastState,
        medicationId: result.medication.id,
        planId: result.planId,
        photoTicket: result.photoTicket,
      };
    }
    return this.call(
      "saveMedication",
      draft as unknown as Record<string, unknown>,
    );
  }
  async archiveMedication(
    id: string,
    expectedVersion: number,
  ): Promise<AppState> {
    await cancelMedicationSync(this, id);
    return this.call("archiveMedication", { id, expectedVersion });
  }
  restoreMedication(id: string, expectedVersion: number): Promise<AppState> {
    return this.call("restoreMedication", { id, expectedVersion });
  }
  async deleteMedication(
    id: string,
    expectedVersion: number,
  ): Promise<AppState> {
    await cancelMedicationSync(this, id);
    return this.call("deleteMedication", { id, expectedVersion });
  }
  prepareMedicationPhoto(
    medicationId: string,
    expectedVersion: number,
    context?: PhotoRpcContext,
  ): Promise<MedicationPhotoUploadTicket> {
    return this.call(
      "prepareMedicationPhoto",
      {
        medicationId,
        expectedVersion,
      },
      context,
    );
  }
  async uploadMedicationPhoto(
    input: {
      medicationId: string;
      expectedVersion: number;
      mediaId: string;
      base64: string;
    },
    context?: PhotoRpcContext,
  ): Promise<{ fileId: string; completedState?: AppState }> {
    const chunkLength = 48 * 1024;
    const { base64, ...identity } = input;
    const totalLength = base64.length;
    if (totalLength < 4 || totalLength > 2796204 || totalLength % 4 !== 0) {
      throw new ServiceError("PAYLOAD_TOO_LARGE", "照片数据大小无效");
    }
    const count = Math.ceil(totalLength / chunkLength);
    let next = 0;
    let failure: unknown;
    const worker = async () => {
      while (next < count && !failure) {
        const index = next++;
        try {
          await this.call(
            "putMedicationPhotoChunk",
            {
              ...identity,
              totalLength,
              index,
              base64: base64.slice(
                index * chunkLength,
                (index + 1) * chunkLength,
              ),
            },
            context
              ? {
                  ...context,
                  requestId: `${context.requestId ?? context.attemptId}:chunk:${index}`,
                  stage: "upload_chunk",
                  base64Length: chunkLength,
                  rawByteSize: undefined,
                }
              : undefined,
          );
        } catch (error) {
          failure = error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, count) }, worker));
    if (failure)
      throw failure instanceof Error
        ? failure
        : new ServiceError("NETWORK", "照片分块未完成", true, "unknown");
    if (context?.completePhoto) {
      const medication = await this.call<Medication>(
        "completeMedicationPhotoUpload",
        { ...identity, totalLength },
        {
          ...context,
          requestId: `${context.requestId ?? context.attemptId}:complete`,
          stage: "upload_finalize",
        },
      );
      if (!this.lastState)
        throw new ServiceError("NETWORK", "保存结果待确认", true, "unknown");
      this.lastState = {
        ...this.lastState,
        medications: this.lastState.medications.map((item) =>
          item.id === medication.id ? medication : item,
        ),
        updatedAt: medication.updatedAt,
      };
      return {
        fileId: medication.photo?.fileId ?? "attached",
        completedState: this.lastState,
      };
    }
    return this.call(
      "finishMedicationPhotoUpload",
      { ...identity, totalLength },
      context ? { ...context, stage: "upload_finalize" } : undefined,
    );
  }
  commitMedicationPhoto(
    input: CommitMedicationPhotoInput,
    context?: PhotoRpcContext,
  ): Promise<AppState> {
    return this.call(
      "commitMedicationPhoto",
      input as unknown as Record<string, unknown>,
      context,
    );
  }
  removeMedicationPhoto(
    medicationId: string,
    expectedVersion: number,
    context?: PhotoRpcContext,
  ): Promise<AppState> {
    return this.call(
      "removeMedicationPhoto",
      {
        medicationId,
        expectedVersion,
      },
      context,
    );
  }
  async discardMedicationPhoto(
    mediaId: string,
    fileId: string | null,
    context?: PhotoRpcContext,
  ): Promise<void> {
    await this.call<unknown>(
      "discardMedicationPhoto",
      { mediaId, fileId },
      context,
    );
  }
  getMedicationPhotoStatus(
    medicationId: string,
    mediaId: string,
    context?: PhotoRpcContext,
  ): Promise<MedicationPhotoStatus> {
    return this.call(
      "getMedicationPhotoStatus",
      { medicationId, mediaId },
      context,
    );
  }
  recordSubscriptionGrant(
    kind: ReminderKind,
    templateId: string,
    status: "accept" | "reject",
    medicationId?: string,
  ): Promise<{ kind: ReminderKind; status: string; usableCount: number }> {
    return this.call("recordSubscriptionGrant", {
      kind,
      templateId,
      status,
      ...(medicationId ? { medicationId } : {}),
    });
  }
  getReminderStatus(medicationId?: string): Promise<ReminderStatus> {
    return this.call("getReminderStatus", medicationId ? { medicationId } : {});
  }
  updateReminderSettings(
    kind: ReminderKind,
    enabled: boolean,
    leadDays?: number,
  ): Promise<AppState> {
    return this.call("updateReminderSettings", {
      kind,
      enabled,
      ...(leadDays === undefined ? {} : { leadDays }),
    });
  }
  confirmInventory(
    input: Parameters<DataService["confirmInventory"]>[0],
  ): Promise<AppState> {
    return this.call("confirmInventory", input);
  }
  recordIntake(
    input: RecordIntakeInput,
    context?: PhotoRpcContext,
  ): Promise<AppState> {
    return this.call(
      context ? "recordIntakeQueued" : "recordIntake",
      input as unknown as Record<string, unknown>,
      context,
    );
  }
  undoIntake(logId: string, expectedVersion: number): Promise<AppState> {
    return this.call("undoIntake", { logId, expectedVersion });
  }
  saveCalendarExport(
    input: Omit<CalendarExport, "id" | "exportedAt" | "staleAt" | "version">,
  ): Promise<AppState> {
    return this.call("saveCalendarExport", input);
  }
  updateSettings(patch: Partial<AccountSettings>): Promise<AppState> {
    return this.call("updateSettings", patch);
  }
  exportData(): Promise<string> {
    return this.call("exportData");
  }
  async deleteAccount(): Promise<void> {
    clearAccountSync(this);
    await this.call<null>("deleteAccount");
    if (this.syncScope) clearInventorySession(this);
    this.syncScope = undefined;
    this.lastState = undefined;
    clearLocalCalendarLedger();
  }
}

export const createDataService = (mode: "local" | "cloud"): DataService =>
  mode === "cloud" ? new CloudDataService() : new LocalDataService();

export const __testables = { parseStoredState };
