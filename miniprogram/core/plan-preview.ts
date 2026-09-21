import {
  addDays,
  endOfLocalDayMs,
  formatDose,
  localDateTimeToMs,
  todayKey,
} from "./dates";
import { resolveExpiry } from "./expiry";
import type { MedicationDraft, PlanVersion } from "./models";
import { expandOccurrences } from "./schedule";
import { validateMedicationDraft } from "./validation";

export const buildPlanPreview = (
  draft: MedicationDraft,
  nowMs = Date.now(),
) => {
  const empty = [] as Array<{ date: string; text: string }>;
  if (draft.mode !== "scheduled")
    return {
      days: empty,
      message:
        draft.mode === "as_needed"
          ? "按需记录，不生成固定安排"
          : "只记效期，不生成固定安排",
    };
  const errors = validateMedicationDraft(draft, {
    today: todayKey(nowMs),
  }).fieldErrors;
  const relevant = Object.entries(errors).filter(
    ([key]) =>
      ![
        "name",
        "profileId",
        "note",
        "specification",
        "initialQuantityMilli",
        "storageLocation",
      ].includes(key),
  );
  if (!draft.schedule || relevant.length)
    return { days: empty, message: relevant[0]?.[1] ?? "请先填写计划" };
  const schedule = draft.schedule;
  const timestamp = new Date(nowMs).toISOString();
  const plan: PlanVersion = {
    id: "preview",
    medicationId: "preview",
    scheduleType: schedule.type,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    weekdays: schedule.weekdays,
    times: schedule.times,
    doseMilli: schedule.doseMilli,
    effectiveFrom: timestamp,
    effectiveTo: null,
    createdAt: timestamp,
    version: 1,
  };
  const lastDate = addDays(todayKey(nowMs), 6);
  const expiry = resolveExpiry(draft).effectiveExpiryDate;
  const to = Math.min(
    endOfLocalDayMs(localDateTimeToMs(lastDate, "12:00")),
    endOfLocalDayMs(localDateTimeToMs(expiry, "12:00")),
  );
  const items = expandOccurrences([plan], nowMs + 1, to);
  const dates = [...new Set(items.map((item) => item.localDate))];
  return {
    days: dates.map((date) => ({
      date,
      text: items
        .filter((item) => item.localDate === date)
        .map(
          (item) => `${item.time} · ${formatDose(item.doseMilli, draft.unit)}`,
        )
        .join("；"),
    })),
    message: items.length
      ? "今天起 7 个北京时间自然日，仅展示之后的安排；不代表通知已获授权。"
      : "这 7 天内没有后续安排，请核对开始日期、星期与管理期限。",
  };
};
