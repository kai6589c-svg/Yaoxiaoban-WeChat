import type { SaveJob } from "./save-queue";

/** Presentation only: an edit target is not evidence that the edit was saved. */
export const saveJobView = (job: SaveJob) => {
  const fieldsConfirmed = Boolean(job.medicationId);
  const canReselect =
    fieldsConfirmed &&
    job.change === "replace" &&
    job.status !== "ready" &&
    ![
      "CONFLICT",
      "VERSION_CONFLICT",
      "FORBIDDEN",
      "UNAUTHORIZED",
      "MEDICATION_ARCHIVED",
      "NOT_FOUND",
    ].includes(job.failureCode ?? "");
  let message =
    job.status === "ready"
      ? "已保存"
      : fieldsConfirmed
        ? "药盒信息已保存，照片待同步"
        : "药盒信息待确认";
  if (fieldsConfirmed && job.uncertain)
    message = "药盒信息已保存，照片结果待确认";
  if (job.failureCode === "LOCAL_FILE_MISSING")
    message = "药盒信息已保存，本机照片已丢失，请重新选择";
  if (job.terminal && !canReselect) message = job.message;
  return {
    message,
    fieldsConfirmed,
    canReselect,
    canRetry: !job.terminal && job.status !== "ready",
    canDiscard: !job.uncertain || fieldsConfirmed,
  };
};
