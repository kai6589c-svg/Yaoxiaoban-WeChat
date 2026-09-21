"use strict";

const { fail } = require("./errors");
const v = require("./validation");

function parseCompatAction(action, payload) {
  switch (action) {
    case "getTodayDashboard":
    case "bootstrap":
    case "exportData":
    case "deleteAccount":
      v.keys(payload, []);
      return {};
    case "acceptPrivacy":
      v.keys(payload, ["version"]);
      return {
        version: v.string(payload.version, "version", { min: 1, max: 50 }),
      };
    case "upsertProfile":
      return parseProfile(payload);
    case "archiveProfile":
    case "archiveMedication":
    case "restoreMedication":
    case "deleteMedication":
      v.keys(payload, ["id", "expectedVersion"]);
      return {
        id: v.id(payload.id),
        expectedVersion: v.expectedVersion(payload.expectedVersion),
      };
    case "saveMedicationFast": {
      const { preparePhoto, ...draft } = payload;
      return {
        ...parseMedication(draft),
        preparePhoto:
          preparePhoto === undefined
            ? false
            : v.boolean(preparePhoto, "preparePhoto"),
      };
    }
    case "saveMedication":
      return parseMedication(payload);
    case "putMedicationPhotoChunk":
      return require("./photo-chunks").parsePhotoChunks(payload, true);
    case "completeMedicationPhotoUpload":
    case "finishMedicationPhotoUpload":
      return require("./photo-chunks").parsePhotoChunks(payload, false);
    case "uploadMedicationPhoto":
      return parsePhotoUpload(payload);
    case "processMedicationPhoto":
      v.keys(payload, ["medicationId"]);
      return { medicationId: v.id(payload.medicationId, "medicationId") };
    case "prepareMedicationPhoto":
      return parsePhotoPrepare(payload);
    case "commitMedicationPhoto":
      return parsePhotoCommit(payload);
    case "removeMedicationPhoto":
      return parsePhotoRemove(payload);
    case "discardMedicationPhoto":
      return parsePhotoDiscard(payload);
    case "getMedicationPhotoStatus":
      v.keys(payload, ["medicationId", "mediaId"]);
      return {
        medicationId: v.id(payload.medicationId, "medicationId"),
        mediaId: v.id(payload.mediaId, "mediaId"),
      };
    case "recordSubscriptionGrant":
      v.keys(payload, ["kind", "templateId", "status", "medicationId"]);
      return {
        kind: v.oneOf(payload.kind, "kind", ["dose", "expiry", "shortage"]),
        templateId: v.string(payload.templateId, "templateId", {
          min: 1,
          max: 80,
        }),
        status: v.oneOf(payload.status, "status", ["accept", "reject"]),
        medicationId: payload.medicationId
          ? v.id(payload.medicationId, "medicationId")
          : null,
      };
    case "getReminderStatus":
      v.keys(payload, ["medicationId"]);
      return {
        medicationId: payload.medicationId
          ? v.id(payload.medicationId, "medicationId")
          : null,
      };
    case "updateReminderSettings":
      v.keys(payload, ["kind", "enabled", "leadDays"]);
      return {
        kind: v.oneOf(payload.kind, "kind", ["dose", "expiry", "shortage"]),
        enabled: v.boolean(payload.enabled, "enabled"),
        leadDays:
          payload.leadDays === undefined
            ? null
            : v.finiteNumber(payload.leadDays, "leadDays", {
                min: 0,
                max: 90,
                integer: true,
              }),
      };
    case "confirmInventory":
      return parseInventory(payload);
    case "recordIntakeQueued":
    case "recordIntake":
      return parseIntake(payload);
    case "undoIntake":
      v.keys(payload, ["logId", "expectedVersion"]);
      return {
        logId: v.id(payload.logId, "logId"),
        expectedVersion: v.expectedVersion(payload.expectedVersion),
      };
    case "saveCalendarExport":
      return parseCalendar(payload);
    case "updateSettings":
      return parseSettings(payload);
    default:
      fail("INVALID_ARGUMENT", "action 不受支持");
  }
}

function parsePhotoUpload(payload) {
  v.keys(payload, ["medicationId", "expectedVersion", "mediaId", "base64"]);
  const base64 = payload.base64;
  if (typeof base64 !== "string" || !base64.length || base64.length > 2796204)
    fail("PAYLOAD_TOO_LARGE", "照片压缩后仍超过 2MB，请重新拍摄");
  // Decode/re-encode rejects malformed and non-canonical base64 without a
  // large repeating regex (which can overflow the JS regexp stack).
  const content = Buffer.from(base64, "base64");
  if (content.toString("base64") !== base64)
    fail("INVALID_MEDIA", "照片数据无效，请重新选择");
  if (content.length > 2 * 1024 * 1024)
    fail("PAYLOAD_TOO_LARGE", "照片压缩后仍超过 2MB，请重新拍摄");
  return {
    medicationId: v.id(payload.medicationId, "medicationId"),
    expectedVersion: v.expectedVersion(payload.expectedVersion),
    mediaId: v.id(payload.mediaId, "mediaId"),
    base64,
  };
}

function parsePhotoPrepare(payload) {
  v.keys(payload, ["medicationId", "expectedVersion"]);
  return {
    medicationId: v.id(payload.medicationId, "medicationId"),
    expectedVersion: v.expectedVersion(payload.expectedVersion),
  };
}

function parsePhotoCommit(payload) {
  v.keys(payload, ["medicationId", "expectedVersion", "mediaId", "fileId"]);
  return {
    medicationId: v.id(payload.medicationId, "medicationId"),
    expectedVersion: v.expectedVersion(payload.expectedVersion),
    mediaId: v.id(payload.mediaId, "mediaId"),
    fileId: v.string(payload.fileId, "fileId", { min: 16, max: 500 }),
  };
}

function parsePhotoRemove(payload) {
  v.keys(payload, ["medicationId", "expectedVersion"]);
  return {
    medicationId: v.id(payload.medicationId, "medicationId"),
    expectedVersion: v.expectedVersion(payload.expectedVersion),
  };
}

function parsePhotoDiscard(payload) {
  v.keys(payload, ["mediaId", "fileId"]);
  return {
    mediaId: v.id(payload.mediaId, "mediaId"),
    fileId:
      payload.fileId === null || payload.fileId === undefined
        ? null
        : v.string(payload.fileId, "fileId", { min: 16, max: 500 }),
  };
}

function parseProfile(payload) {
  v.keys(payload, ["id", "name", "relation", "color", "expectedVersion"]);
  const id = payload.id ? v.id(payload.id) : null;
  const expectedVersion =
    payload.expectedVersion === undefined
      ? null
      : v.expectedVersion(payload.expectedVersion);
  if (id && expectedVersion === null)
    fail("INVALID_ARGUMENT", "编辑成员必须提供 expectedVersion");
  return {
    id,
    name: v.string(payload.name, "name", { min: 1, max: 10 }),
    relation: v.oneOf(payload.relation, "relation", [
      "self",
      "parent",
      "child",
      "partner",
      "other",
    ]),
    color: v.color(payload.color) ?? "#4E8D70",
    expectedVersion,
  };
}

function parseMedication(payload) {
  v.keys(payload, [
    "id",
    "profileId",
    "name",
    "specification",
    "storageLocation",
    "unit",
    "mode",
    "expiryPrecision",
    "expiryValue",
    "openedDate",
    "afterOpenDays",
    "note",
    "expectedVersion",
    "initialQuantityMilli",
    "schedule",
  ]);
  const id = payload.id ? v.id(payload.id) : null;
  const expectedVersion =
    payload.expectedVersion === undefined
      ? null
      : v.expectedVersion(payload.expectedVersion);
  if (id && expectedVersion === null)
    fail("INVALID_ARGUMENT", "编辑药品必须提供 expectedVersion");
  const mode = v.oneOf(payload.mode, "mode", [
    "expiry_only",
    "scheduled",
    "as_needed",
  ]);
  const expiryPrecision = v.oneOf(payload.expiryPrecision, "expiryPrecision", [
    "day",
    "month",
  ]);
  const openedDate = payload.openedDate
    ? v.date(payload.openedDate, "openedDate")
    : null;
  const afterOpenDays =
    payload.afterOpenDays === null || payload.afterOpenDays === undefined
      ? null
      : v.finiteNumber(payload.afterOpenDays, "afterOpenDays", {
          min: 1,
          max: 3650,
          integer: true,
        });
  if (afterOpenDays && !openedDate)
    fail("INVALID_ARGUMENT", "填写开封后天数时必须填写开启日期");
  if (openedDate && !afterOpenDays)
    fail("INVALID_ARGUMENT", "填写开启日期时必须填写开封后可用天数");
  const initialQuantityMilli =
    payload.initialQuantityMilli === null ||
    payload.initialQuantityMilli === undefined
      ? null
      : v.finiteNumber(payload.initialQuantityMilli, "initialQuantityMilli", {
          min: 0,
          max: 1000000000,
          integer: true,
        });
  const unit = emptyString(payload.unit, "unit", 16);
  if (initialQuantityMilli !== null && !unit)
    fail("INVALID_ARGUMENT", "填写数量时需要选择单位");
  const schedule =
    mode === "expiry_only"
      ? parseNullSchedule(payload.schedule)
      : parseSchedule(payload.schedule, mode);
  return {
    id,
    profileId: v.id(payload.profileId, "profileId"),
    name: v.string(payload.name, "name", { min: 1, max: 40 }),
    specification: emptyString(payload.specification, "specification", 80),
    unit,
    mode,
    expiryPrecision,
    expiryValue:
      expiryPrecision === "day"
        ? v.date(payload.expiryValue, "expiryValue")
        : v.month(payload.expiryValue, "expiryValue"),
    openedDate,
    afterOpenDays,
    note: emptyString(payload.note, "note", 300),
    ...(payload.storageLocation !== undefined
      ? {
          storageLocation: emptyString(
            payload.storageLocation,
            "storageLocation",
            30,
          ),
        }
      : {}),
    expectedVersion,
    initialQuantityMilli,
    schedule,
  };
}

function parseNullSchedule(value) {
  if (value !== null && value !== undefined)
    fail("INVALID_ARGUMENT", "仅管理效期时不能设置服药计划");
  return null;
}

function parseSchedule(value, mode) {
  v.record(value, "schedule");
  v.keys(
    value,
    ["type", "startDate", "endDate", "weekdays", "times", "doseMilli"],
    "schedule",
  );
  const type = v.oneOf(value.type, "schedule.type", [
    "daily",
    "weekly",
    "as_needed",
  ]);
  if ((mode === "as_needed") !== (type === "as_needed"))
    fail("INVALID_ARGUMENT", "药品模式与计划类型不一致");
  const startDate = v.date(value.startDate, "schedule.startDate");
  const endDate = value.endDate
    ? v.date(value.endDate, "schedule.endDate")
    : null;
  if (endDate && endDate < startDate)
    fail("INVALID_ARGUMENT", "结束日期不能早于开始日期");
  return {
    type,
    startDate,
    endDate,
    weekdays:
      type === "weekly"
        ? v
            .uniqueArray(
              value.weekdays,
              "schedule.weekdays",
              (item, label) =>
                v.finiteNumber(item, label, { min: 1, max: 7, integer: true }),
              { min: 1, max: 7 },
            )
            .sort()
        : [],
    times:
      type === "as_needed"
        ? []
        : v
            .uniqueArray(
              value.times,
              "schedule.times",
              (item, label) => v.time(item, label),
              { min: 1, max: 12 },
            )
            .sort(),
    doseMilli: v.finiteNumber(value.doseMilli, "schedule.doseMilli", {
      min: 1,
      max: 100000000,
      integer: true,
    }),
  };
}

function parseInventory(payload) {
  v.keys(payload, [
    "medicationId",
    "quantityMilli",
    "note",
    "recordedAt",
    "requestId",
  ]);
  return {
    medicationId: v.id(payload.medicationId, "medicationId"),
    quantityMilli: v.finiteNumber(payload.quantityMilli, "quantityMilli", {
      min: 0,
      max: 1000000000,
      integer: true,
    }),
    note:
      payload.note === undefined
        ? "手动盘点"
        : emptyString(payload.note, "note", 100),
    recordedAt: payload.recordedAt
      ? v.isoTimestamp(payload.recordedAt, "recordedAt")
      : null,
    requestId: payload.requestId ? v.requestId(payload.requestId) : null,
  };
}

function parseIntake(payload) {
  v.keys(payload, [
    "medicationId",
    "planId",
    "occurrenceKey",
    "scheduledAt",
    "status",
    "quantityMilli",
    "occurredAt",
    "requestId",
  ]);
  const status = v.oneOf(payload.status, "status", [
    "taken",
    "skipped",
    "extra",
  ]);
  const planId = payload.planId ? v.id(payload.planId, "planId") : null;
  const scheduledAt = payload.scheduledAt
    ? v.isoTimestamp(payload.scheduledAt, "scheduledAt")
    : null;
  if (status !== "extra" && (!planId || !scheduledAt))
    fail("INVALID_ARGUMENT", "计划服药记录缺少计划或计划时间");
  return {
    medicationId: v.id(payload.medicationId, "medicationId"),
    planId,
    occurrenceKey: payload.occurrenceKey
      ? v.string(payload.occurrenceKey, "occurrenceKey", { min: 1, max: 240 })
      : null,
    scheduledAt,
    status,
    quantityMilli: v.finiteNumber(payload.quantityMilli, "quantityMilli", {
      min: 1,
      max: 100000000,
      integer: true,
    }),
    occurredAt: payload.occurredAt
      ? v.isoTimestamp(payload.occurredAt, "occurredAt")
      : null,
    requestId: payload.requestId ? v.requestId(payload.requestId) : null,
  };
}

function parseCalendar(payload) {
  v.keys(payload, ["medicationId", "planId", "fingerprint", "eventTitle"]);
  return {
    medicationId: v.id(payload.medicationId, "medicationId"),
    planId: v.id(payload.planId, "planId"),
    fingerprint: v.string(payload.fingerprint, "fingerprint", {
      min: 1,
      max: 500,
    }),
    eventTitle: v.string(payload.eventTitle, "eventTitle", { min: 1, max: 80 }),
  };
}

function parseSettings(payload) {
  v.keys(payload, [
    "notificationPrivacy",
    "expiryLeadDays",
    "lowStockLeadDays",
    "timezone",
    "lowFrequencyReminders",
  ]);
  const patch = {};
  if (payload.notificationPrivacy !== undefined) {
    patch.notificationPrivacy = v.oneOf(
      payload.notificationPrivacy,
      "notificationPrivacy",
      ["generic", "detailed"],
    );
  }
  if (payload.expiryLeadDays !== undefined) {
    patch.expiryLeadDays = v.oneOf(
      payload.expiryLeadDays,
      "expiryLeadDays",
      [7, 30, 90],
    );
  }
  if (payload.lowStockLeadDays !== undefined) {
    patch.lowStockLeadDays = v.oneOf(
      payload.lowStockLeadDays,
      "lowStockLeadDays",
      [3, 7, 14],
    );
  }
  if (payload.timezone !== undefined && payload.timezone !== "Asia/Shanghai") {
    fail("INVALID_ARGUMENT", "timezone 只支持 Asia/Shanghai");
  }
  if (payload.lowFrequencyReminders !== undefined) {
    patch.lowFrequencyReminders = v.boolean(
      payload.lowFrequencyReminders,
      "lowFrequencyReminders",
    );
  }
  if (!Object.keys(patch).length)
    fail("INVALID_ARGUMENT", "至少提供一个设置字段");
  return patch;
}

function emptyString(value, label, max) {
  if (value === undefined || value === null) return "";
  return v.string(value, label, { min: 0, max });
}

module.exports = { parseCompatAction };
