import { getIntakeQueue } from "./intake-queue";
import { registerSyncHooks } from "./sync-lifecycle";
import type { MedicationDraft } from "../core/models";
import { createRequestId } from "../core/id";
import {
  ServiceError,
  type DataService,
  type MedicationPhotoUploadTicket,
} from "./data-service";
import {
  stageMedicationPhoto,
  commitStagedMedicationPhoto,
} from "./medication-photo";
import { recordPhotoEvent, type PhotoRpcContext } from "./diagnostics";

// Reserve 200ms of the 10s interaction limit for timer dispatch and UI updates.
export const SAVE_BUDGET_MS = 9_800;
const MAX_JOBS = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export interface SaveJob {
  id: string;
  scope: string;
  draft: MedicationDraft;
  filePath: string;
  change: "replace" | "remove" | "unchanged";
  createdAt: number;
  attempts: number;
  retryAt: number;
  status: "local" | "uploading" | "processing" | "ready" | "failed";
  uncertain: boolean;
  terminal: boolean;
  message: string;
  medicationId?: string;
  version?: number;
  ticket?: MedicationPhotoUploadTicket;
  derivativesDone?: boolean;
  failureCode?: string;
  failureStage?: "fields" | "photo";
}
const key = (scope: string) => `yaoxiaoban:save-queue-v1:${scope}`;
const queues = new WeakMap<DataService, SaveQueue>();
export const getSaveQueue = (service: DataService): SaveQueue => {
  let queue = queues.get(service);
  if (!queue) {
    queue = new SaveQueue(service);
    queues.set(service, queue);
    registerSyncHooks(service, queue);
  }
  return queue;
};

/** A durable task owns the RPCs; the page only observes it for ten seconds. */
export class SaveQueue {
  private running = new Map<string, Promise<SaveJob>>();
  private listeners = new Set<() => void>();
  constructor(private service: DataService) {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A detached page cannot break task persistence. */
      }
    }
  }
  list(): SaveJob[] {
    if (!this.service.syncScope) return [];
    const value: unknown = wx.getStorageSync(key(this.service.syncScope));
    if (!Array.isArray(value)) return [];
    return (value as unknown[]).filter((value): value is SaveJob => {
      if (!value || typeof value !== "object") return false;
      const job = value as Partial<SaveJob>;
      return (
        job.scope === this.service.syncScope &&
        typeof job.id === "string" &&
        Boolean(job.draft)
      );
    });
  }
  private persist(job: SaveJob) {
    if (this.service.syncScope !== job.scope)
      throw new ServiceError("UNAUTHORIZED", "账号已变化，请重新加载");
    const jobs = this.list().filter((item) => item.id !== job.id);
    jobs.push(job);
    wx.setStorageSync(key(job.scope), jobs);
    this.emit();
  }
  start(
    draft: MedicationDraft,
    filePath: string,
    change: SaveJob["change"],
  ): SaveJob {
    const startedAtMs = Date.now();
    const scope = this.service.syncScope;
    if (!scope)
      throw new ServiceError("NETWORK", "请联网加载药盒后再保存", true);
    const existing = this.list().find(
      (job) =>
        job.status !== "ready" &&
        (draft.id
          ? job.medicationId === draft.id || job.draft.id === draft.id
          : JSON.stringify(job.draft) === JSON.stringify(draft)),
    );
    if (existing)
      throw new ServiceError(
        "OPERATION_IN_PROGRESS",
        "已有保存任务，请先在待同步列表中完成或处理",
      );
    const jobs = this.list();
    const retained = jobs.filter(
      (job) =>
        job.status !== "ready" ||
        Boolean(job.filePath) ||
        (job.change === "replace" && !job.derivativesDone),
    );
    if (retained.filter((job) => job.status !== "ready").length >= MAX_JOBS)
      throw new ServiceError(
        "LIMIT_EXCEEDED",
        "待同步任务较多，请先处理后再保存",
      );
    wx.setStorageSync(key(scope), retained);
    const id = createRequestId();
    let durablePath = "";
    if (change === "replace") {
      if (!filePath) throw new ServiceError("INVALID_MEDIA", "请重新选择照片");
      durablePath = `${wx.env.USER_DATA_PATH}/yx-save-${id}.jpg`;
      try {
        wx.getFileSystemManager().copyFileSync(filePath, durablePath);
      } catch {
        throw new ServiceError(
          "INVALID_MEDIA",
          "照片未能保存在本机，请检查剩余空间后重试",
        );
      }
    }
    const job: SaveJob = {
      id,
      scope,
      draft,
      filePath: durablePath,
      change,
      createdAt: startedAtMs,
      attempts: 0,
      retryAt: 0,
      status: "local",
      uncertain: false,
      terminal: false,
      message: "等待保存",
    };
    try {
      this.persist(job);
    } catch (error) {
      this.removeFile(durablePath);
      throw error;
    }
    return job;
  }
  private removeFile(path: string): boolean {
    if (path) {
      try {
        wx.getFileSystemManager().unlinkSync(path);
      } catch {
        return false;
      }
    }
    return true;
  }
  async resume(): Promise<void> {
    for (const job of this.list()) {
      if (
        job.status === "ready" &&
        job.filePath &&
        this.removeFile(job.filePath)
      ) {
        job.filePath = "";
        this.persist(job);
      }
      if (
        job.status === "ready" &&
        job.medicationId &&
        job.change === "replace" &&
        !job.derivativesDone &&
        this.service.processMedicationPhoto
      ) {
        try {
          await this.service.processMedicationPhoto(job.medicationId);
          job.derivativesDone = true;
          this.persist(job);
        } catch {
          /* The media ledger remains pending for the next foreground/maintenance run. */
        }
      }
      if (
        job.status !== "ready" &&
        !job.terminal &&
        job.retryAt <= Date.now() &&
        job.attempts < 5
      )
        await this.run(job.id);
    }
  }
  run(id: string, deadlineAt = Date.now() + SAVE_BUDGET_MS): Promise<SaveJob> {
    const active = this.running.get(id);
    if (active) return active;
    const promise = this.process(id, deadlineAt).finally(() => {
      this.running.delete(id);
    });
    this.running.set(id, promise);
    return promise;
  }
  private async process(id: string, deadlineAt: number): Promise<SaveJob> {
    const job = this.list().find((item) => item.id === id);
    if (!job) throw new ServiceError("NOT_FOUND", "保存任务不存在");
    if (job.status === "ready") return job;
    if (job.terminal) return job;
    const startedAtMs = job.createdAt;
    const context = (stage: PhotoRpcContext["stage"]): PhotoRpcContext => ({
      attemptId: job.id,
      requestId: `${job.id}:${stage}`,
      deadlineAt,
      stage,
    });
    const check = () => {
      if (
        job.scope !== this.service.syncScope ||
        !this.list().some((item) => item.id === job.id)
      )
        throw new ServiceError("UNAUTHORIZED", "保存任务已取消");
      if (Date.now() >= deadlineAt)
        throw new ServiceError(
          "NETWORK",
          "保存结果待确认，可稍后继续同步",
          true,
          "unknown",
        );
    };
    try {
      if (Date.now() - job.createdAt >= MAX_AGE_MS)
        throw new ServiceError(
          "MEDIA_UPLOAD_EXPIRED",
          "任务已超过恢复期限，请联网核对药箱后重新编辑",
          false,
        );
      job.failureCode = undefined;
      job.failureStage = undefined;
      job.attempts++;
      job.status = job.medicationId ? "uploading" : "local";
      this.persist(job);
      check();
      if (!job.medicationId) {
        const result = await this.service.saveMedication(job.draft, {
          ...context("save_fields"),
          preparePhoto: job.change === "replace",
        });
        check();
        const medication = result.state.medications.find(
          (item) => item.id === result.medicationId,
        );
        if (!medication)
          throw new ServiceError("NETWORK", "保存结果待确认", true, "unknown");
        job.medicationId = medication.id;
        job.version = medication.version;
        job.ticket = result.photoTicket;
        job.uncertain = false;
        job.message = "药盒已保存，照片待同步";
        this.persist(job);
      }
      check();
      if (job.change === "replace") {
        if (job.ticket && job.attempts > 1) {
          const remote = await this.service.getMedicationPhotoStatus(
            job.medicationId!,
            job.ticket.mediaId,
            context("retry_bootstrap"),
          );
          check();
          if (remote.status === "attached") {
            // Server confirmation is sufficient; the next page fetches current state.
            job.derivativesDone = false;
            job.status = "ready";
          } else if (["cleanup_pending", "expired"].includes(remote.status)) {
            throw new ServiceError(
              "INVALID_MEDIA_STATE",
              "照片任务需要重新处理，请联网核对后重新编辑",
              false,
            );
          }
        }
        if (job.status !== "ready") {
          try {
            wx.getFileSystemManager().accessSync(job.filePath);
          } catch {
            throw new ServiceError(
              "LOCAL_FILE_MISSING",
              "本机照片已丢失，请重新选择照片",
            );
          }
          job.status = "uploading";
          this.persist(job);
          const staged = await stageMedicationPhoto({
            service: this.service,
            medicationId: job.medicationId!,
            expectedVersion: job.version!,
            tempFilePath: job.filePath,
            attemptId: job.id,
            requestId: job.id,
            deadlineAt,
            ticket: job.ticket,
            onTicket: (ticket) => {
              check();
              job.ticket = ticket;
              this.persist(job);
            },
          });
          check();
          job.status = "processing";
          this.persist(job);
          const state = await commitStagedMedicationPhoto({
            service: this.service,
            medicationId: job.medicationId!,
            expectedVersion: job.version!,
            staged,
            attemptId: job.id,
            deadlineAt,
            requestId: `${job.id}:commit`,
          });
          job.version =
            state.medications.find((item) => item.id === job.medicationId)
              ?.version ?? job.version;
        }
      } else if (job.change === "remove") {
        await this.service.removeMedicationPhoto(
          job.medicationId!,
          job.version!,
          context("commit"),
        );
      }
      check();
      job.status = "ready";
      job.uncertain = false;
      job.message = "已保存";
      this.persist(job);
      if (this.removeFile(job.filePath)) job.filePath = "";
      this.persist(job);
      recordPhotoEvent({
        ...context("save_total"),
        outcome: "success",
        startedAtMs,
      });
    } catch (error) {
      const failure =
        error instanceof ServiceError
          ? error
          : new ServiceError(
              "NETWORK",
              "保存未完成，请稍后重试",
              true,
              "unknown",
            );
      job.failureCode = failure.code;
      job.failureStage = job.medicationId ? "photo" : "fields";
      job.uncertain = failure.outcome === "unknown";
      job.status = "failed";
      job.terminal =
        !failure.retryable ||
        [
          "CONFLICT",
          "VERSION_CONFLICT",
          "INVALID_MEDIA_STATE",
          "FORBIDDEN",
          "UNAUTHORIZED",
          "MEDICATION_ARCHIVED",
          "NOT_FOUND",
        ].includes(failure.code);
      job.message = job.terminal
        ? failure.message
        : job.medicationId
          ? "药盒已保存，照片待同步"
          : "保存结果待确认";
      job.retryAt =
        Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(job.attempts, 5));
      if (
        this.service.syncScope === job.scope &&
        this.list().some((item) => item.id === job.id)
      )
        this.persist(job);
      recordPhotoEvent({
        ...context("save_total"),
        outcome: job.uncertain ? "unknown" : "failure",
        startedAtMs,
        error: failure,
      });
    }
    return job;
  }
  reselectPhoto(
    id: string,
    filePath: string,
    deadlineAt = Date.now() + SAVE_BUDGET_MS,
  ): Promise<SaveJob> {
    if (this.running.has(id))
      return Promise.reject(
        new ServiceError("OPERATION_IN_PROGRESS", "任务仍在处理中，请稍后核对"),
      );
    const work = this.repairPhoto(id, filePath, deadlineAt).finally(() =>
      this.running.delete(id),
    );
    this.running.set(id, work);
    return work;
  }
  private async repairPhoto(
    id: string,
    filePath: string,
    deadlineAt: number,
  ): Promise<SaveJob> {
    const job = this.list().find((item) => item.id === id);
    if (!job?.medicationId || job.change !== "replace")
      throw new ServiceError(
        "OPERATION_IN_PROGRESS",
        "请先确认药盒信息已保存，再补选照片",
      );
    if (job.status === "ready") return job;
    const check = () => {
      if (
        this.service.syncScope !== job.scope ||
        !this.list().some((item) => item.id === id)
      )
        throw new ServiceError("UNAUTHORIZED", "账号或任务已变化，请重新加载");
      if (Date.now() >= deadlineAt)
        throw new ServiceError(
          "NETWORK",
          "核对未完成，请稍后重试",
          true,
          "unknown",
        );
    };
    const context = (stage: PhotoRpcContext["stage"]): PhotoRpcContext => ({
      attemptId: job.id,
      requestId: `${job.id}:repair:${stage}`,
      stage,
      deadlineAt,
    });
    const remoteStatus = async (stage: PhotoRpcContext["stage"]) => {
      try {
        return await this.service.getMedicationPhotoStatus(
          job.medicationId!,
          job.ticket!.mediaId,
          context(stage),
        );
      } catch (error) {
        if (error instanceof ServiceError && error.code === "MEDIA_NOT_FOUND")
          return { status: "missing" };
        throw error;
      }
    };
    const markReady = () => {
      job.status = "ready";
      job.uncertain = false;
      job.terminal = false;
      job.message = "照片已保存";
      job.failureCode = undefined;
      this.persist(job);
      if (this.removeFile(job.filePath)) {
        job.filePath = "";
        this.persist(job);
      }
      return job;
    };
    check();
    if (job.ticket) {
      const remote = await remoteStatus("retry_bootstrap");
      check();
      if (remote.status === "attached") return markReady();
    }
    const state = await this.service.bootstrap();
    check();
    const medication = state.medications.find(
      (item) => item.id === job.medicationId,
    );
    if (!medication || medication.archivedAt)
      throw new ServiceError("NOT_FOUND", "药盒已归档或不存在，请先核对");
    if (medication.version !== job.version)
      throw new ServiceError(
        "VERSION_CONFLICT",
        "药盒已变化，请核对后重新编辑",
      );
    if (job.ticket) {
      await this.service.discardMedicationPhoto(
        job.ticket.mediaId,
        null,
        context("discard"),
      );
      check();
      const remote = await remoteStatus("read_back");
      check();
      if (remote.status === "attached") return markReady();
      if (
        !["cleanup_pending", "expired", "deleted", "missing"].includes(
          remote.status,
        )
      )
        throw new ServiceError(
          "OPERATION_IN_PROGRESS",
          "原照片任务尚未结束，请稍后核对",
        );
    }
    const newId = createRequestId();
    const durablePath = `${wx.env.USER_DATA_PATH}/yx-save-${newId}.jpg`;
    try {
      wx.getFileSystemManager().copyFileSync(filePath, durablePath);
    } catch {
      throw new ServiceError(
        "INVALID_MEDIA",
        "照片未能保存在本机，请检查空间后重试",
      );
    }
    const replacement: SaveJob = {
      ...job,
      id: newId,
      filePath: durablePath,
      createdAt: Date.now(),
      attempts: 0,
      retryAt: 0,
      status: "local",
      uncertain: false,
      terminal: false,
      message: "药盒信息已保存，照片待同步",
      ticket: undefined,
      failureCode: undefined,
      failureStage: undefined,
      derivativesDone: false,
    };
    try {
      check();
      wx.setStorageSync(key(job.scope), [
        ...this.list().filter((item) => item.id !== id),
        replacement,
      ]);
    } catch (error) {
      this.removeFile(durablePath);
      throw error;
    }
    this.removeFile(job.filePath);
    this.emit();
    return this.run(replacement.id, deadlineAt);
  }
  async discard(id: string): Promise<void> {
    if (this.running.has(id))
      throw new ServiceError(
        "OPERATION_IN_PROGRESS",
        "任务仍在处理中，请稍后核对",
      );
    const job = this.list().find((item) => item.id === id);
    if (!job) return;
    if (job.uncertain && !job.medicationId)
      throw new ServiceError(
        "OPERATION_IN_PROGRESS",
        "药盒保存结果仍待确认，请先联网重试，避免重复添加",
      );
    if (job.ticket && job.status !== "ready")
      await this.service.discardMedicationPhoto(job.ticket.mediaId, null);
    wx.setStorageSync(
      key(job.scope),
      this.list().filter((item) => item.id !== id),
    );
    this.removeFile(job.filePath);
    this.emit();
  }
  async cancelMedication(id: string): Promise<void> {
    for (const job of this.list().filter(
      (item) => item.medicationId === id || item.draft.id === id,
    ))
      await this.discard(job.id);
  }
  clear(): void {
    getIntakeQueue(this.service).clear();
    for (const job of this.list()) this.removeFile(job.filePath);
    if (this.service.syncScope)
      wx.removeStorageSync(key(this.service.syncScope));
    this.emit();
  }
}

export const observeSave = <T>(
  work: Promise<T>,
  deadlineAt: number,
): Promise<T | null> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resolve(null),
      Math.max(0, deadlineAt - Date.now()),
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("保存请求未完成"));
      },
    );
  });
