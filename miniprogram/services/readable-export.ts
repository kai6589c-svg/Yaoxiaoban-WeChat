import type { AppState } from "../core/models";
import { formatChineseDate } from "../core/dates";
import { resolveExpiry } from "../core/expiry";
export const readableMedicineList = (state: AppState): string => {
  const modes = {
    expiry_only: "只管效期",
    scheduled: "固定服用",
    as_needed: "按需使用",
  };
  const cards = state.medications.map((med, index) => {
    const profile =
      state.profiles.find((item) => item.id === med.profileId)?.name ?? "成员";
    return `${index + 1}. ${med.name}${med.archivedAt ? "（已移除）" : ""}\n成员：${profile}\n规格：${med.specification || "未填写"}\n存放位置：${med.storageLocation || "未填写"}\n使用方式：${modes[med.mode]}\n包装有效期：${formatChineseDate(med.expiryValue, med.expiryPrecision)}\n管理期限：${formatChineseDate(resolveExpiry(med).effectiveExpiryDate)}\n开封日期：${med.openedDate || "未记录"}${med.afterOpenDays ? `；开封后 ${med.afterOpenDays} 天` : ""}\n备注：${med.note || "无"}`;
  });
  return `药小伴 · 药盒清单\n导出时间：${new Date().toISOString()}\n共 ${cards.length} 盒（含已移除药盒）\n仅为已记录信息，提醒是否添加请在小程序详情中查看。\n\n${cards.join("\n\n") || "暂无药盒"}`;
};
