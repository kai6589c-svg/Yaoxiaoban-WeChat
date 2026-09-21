import { isValidDateKey, isValidMonthKey, isValidTimeKey } from "./dates";
import { calculateEffectiveExpiry } from "./expiry";
import type { MedicationDraft, Profile } from "./models";

export interface ValidationResult {
  valid: boolean;
  fieldErrors: Record<string, string>;
}

const fail = (
  errors: Record<string, string>,
  field: string,
  message: string,
): void => {
  if (!errors[field]) errors[field] = message;
};

export const validateMedicationDraft = (
  draft: MedicationDraft,
  context: { today?: string } = {},
): ValidationResult => {
  const errors: Record<string, string> = {};
  if ((draft.storageLocation?.trim().length ?? 0) > 30)
    fail(errors, "storageLocation", "存放位置不能超过30个字");
  const name = draft.name.trim();
  if (!name) fail(errors, "name", "请填写药名");
  if (name.length > 40) fail(errors, "name", "药名不能超过40个字");
  if (!draft.profileId) fail(errors, "profileId", "请选择使用成员");
  if (draft.specification.trim().length > 80)
    fail(errors, "specification", "规格不能超过80个字");
  if (draft.note.trim().length > 300)
    fail(errors, "note", "备注不能超过300个字");
  if (draft.unit.trim().length > 16) fail(errors, "unit", "单位不能超过16个字");

  const expiryValid =
    draft.expiryPrecision === "day"
      ? isValidDateKey(draft.expiryValue)
      : isValidMonthKey(draft.expiryValue);
  if (!expiryValid) fail(errors, "expiryValue", "请选择包装上标注的有效期");
  const expiryResolution = calculateEffectiveExpiry({
    expiryPrecision: draft.expiryPrecision,
    expiryValue: draft.expiryValue,
    openedDate: draft.openedDate,
    afterOpenDays: draft.afterOpenDays,
  });

  if (draft.openedDate && !isValidDateKey(draft.openedDate)) {
    fail(errors, "openedDate", "开启日期格式不正确");
  } else if (draft.openedDate) {
    if (context.today && draft.openedDate > context.today) {
      fail(errors, "openedDate", "开启日期不能晚于今天");
    }
    if (expiryResolution) {
      if (draft.openedDate > expiryResolution.packageExpiryDate) {
        fail(errors, "openedDate", "开启日期不能晚于包装有效期");
      }
    }
  }
  if (draft.afterOpenDays !== null && draft.afterOpenDays !== undefined) {
    if (
      !Number.isInteger(draft.afterOpenDays) ||
      draft.afterOpenDays < 1 ||
      draft.afterOpenDays > 3650
    ) {
      fail(errors, "afterOpenDays", "开封后天数应为1至3650的整数");
    }
    if (!draft.openedDate) fail(errors, "openedDate", "请先填写开启日期");
  } else if (draft.openedDate) {
    fail(errors, "afterOpenDays", "请填写包装标注的开封后可用天数");
  }

  const effectiveExpiry = expiryResolution?.effectiveExpiryDate;

  if (
    draft.initialQuantityMilli !== null &&
    draft.initialQuantityMilli !== undefined
  ) {
    if (
      !Number.isInteger(draft.initialQuantityMilli) ||
      draft.initialQuantityMilli < 0 ||
      draft.initialQuantityMilli > 1_000_000_000
    ) {
      fail(errors, "initialQuantityMilli", "请输入不小于0、最多三位小数的数量");
    }
    if (!draft.unit.trim()) fail(errors, "unit", "填写数量时需要选择单位");
  }

  if (draft.mode !== "expiry_only") {
    if (!draft.schedule) {
      fail(errors, "schedule", "请设置服药计划");
    } else {
      if (!isValidDateKey(draft.schedule.startDate))
        fail(errors, "startDate", "请选择开始日期");
      if (draft.schedule.endDate && !isValidDateKey(draft.schedule.endDate)) {
        fail(errors, "endDate", "结束日期格式不正确");
      }
      if (
        draft.schedule.endDate &&
        draft.schedule.endDate < draft.schedule.startDate
      ) {
        fail(errors, "endDate", "结束日期不能早于开始日期");
      }
      if (
        !Number.isInteger(draft.schedule.doseMilli) ||
        draft.schedule.doseMilli <= 0 ||
        draft.schedule.doseMilli > 100_000_000
      ) {
        fail(errors, "doseMilli", "请输入大于0、最多三位小数的每次用量");
      }
      if (!draft.unit.trim()) fail(errors, "unit", "请填写用量单位");
      if (draft.schedule.type !== "as_needed") {
        if (
          !draft.schedule.times.length ||
          draft.schedule.times.some((time) => !isValidTimeKey(time))
        ) {
          fail(errors, "times", "请至少设置一个有效时间");
        }
        if (
          new Set(draft.schedule.times).size !== draft.schedule.times.length
        ) {
          fail(errors, "times", "同一时间不能重复添加");
        }
      }
      if (
        draft.schedule.type === "weekly" &&
        (!draft.schedule.weekdays.length ||
          draft.schedule.weekdays.some(
            (day) => !Number.isInteger(day) || day < 1 || day > 7,
          ))
      ) {
        fail(errors, "weekdays", "请至少选择一个星期");
      }
      if (
        (draft.mode === "as_needed") !==
        (draft.schedule.type === "as_needed")
      ) {
        fail(errors, "schedule", "服药方式与计划类型不一致");
      }
      if (
        effectiveExpiry &&
        isValidDateKey(draft.schedule.startDate) &&
        draft.schedule.startDate > effectiveExpiry
      ) {
        fail(errors, "startDate", "计划开始日期不能晚于管理期限");
      }
      if (
        effectiveExpiry &&
        draft.schedule.endDate &&
        isValidDateKey(draft.schedule.endDate) &&
        draft.schedule.endDate > effectiveExpiry
      ) {
        fail(errors, "endDate", "计划结束日期不能晚于管理期限");
      }
    }
  }

  return { valid: Object.keys(errors).length === 0, fieldErrors: errors };
};

export const validateProfile = (
  profile: Pick<Profile, "name" | "relation">,
): ValidationResult => {
  const errors: Record<string, string> = {};
  const name = profile.name.trim();
  if (!name) fail(errors, "name", "请填写成员称呼");
  if (name.length > 10) fail(errors, "name", "称呼不能超过10个字");
  return { valid: Object.keys(errors).length === 0, fieldErrors: errors };
};
