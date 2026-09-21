"use strict";

const v = require("./validation");
const { fail } = require("./errors");

function parseEmpty(payload) {
  v.keys(payload, []);
  return {};
}

function parseList(payload, parentKey = "medicationId") {
  v.keys(payload, [parentKey, "cursor", "limit"]);
  return {
    [parentKey]:
      payload[parentKey] === undefined
        ? null
        : v.id(payload[parentKey], parentKey),
    cursor:
      payload.cursor === undefined ? null : v.id(payload.cursor, "cursor"),
    limit:
      payload.limit === undefined
        ? 50
        : v.finiteNumber(payload.limit, "limit", {
            min: 1,
            max: 100,
            integer: true,
          }),
  };
}

function parseProfileCreate(payload) {
  v.keys(payload, ["displayName", "relation", "color"]);
  return {
    displayName: v.string(payload.displayName, "displayName", {
      min: 1,
      max: 20,
    }),
    relation: v.oneOf(payload.relation ?? "other", "relation", [
      "self",
      "parent",
      "child",
      "partner",
      "other",
    ]),
    color: v.color(payload.color),
  };
}

function parseProfileUpdate(payload) {
  v.keys(payload, [
    "id",
    "expectedVersion",
    "displayName",
    "relation",
    "color",
  ]);
  const patch = {};
  if (payload.displayName !== undefined)
    patch.displayName = v.string(payload.displayName, "displayName", {
      min: 1,
      max: 20,
    });
  if (payload.relation !== undefined)
    patch.relation = v.oneOf(payload.relation, "relation", [
      "self",
      "parent",
      "child",
      "partner",
      "other",
    ]);
  if (payload.color !== undefined) patch.color = v.color(payload.color);
  if (!Object.keys(patch).length) throwInvalidPatch();
  return {
    id: v.id(payload.id),
    expectedVersion: v.expectedVersion(payload.expectedVersion),
    patch,
  };
}

function parseIdVersion(payload) {
  v.keys(payload, ["id", "expectedVersion"]);
  return {
    id: v.id(payload.id),
    expectedVersion: v.expectedVersion(payload.expectedVersion),
  };
}

function parseId(payload) {
  v.keys(payload, ["id"]);
  return { id: v.id(payload.id) };
}

function parseExpiry(value) {
  if (value === undefined || value === null) return null;
  v.keys(value, ["precision", "value"], "expiry");
  const precision = v.oneOf(value.precision, "expiry.precision", [
    "day",
    "month",
  ]);
  return {
    precision,
    value:
      precision === "day"
        ? v.date(value.value, "expiry.value")
        : v.month(value.value, "expiry.value"),
  };
}

function medicationFields(payload, { partial = false } = {}) {
  const result = {};
  if (!partial || payload.profileId !== undefined)
    result.profileId = v.id(payload.profileId, "profileId");
  if (!partial || payload.name !== undefined)
    result.name = v.string(payload.name, "name", { min: 1, max: 80 });
  if (payload.specification !== undefined)
    result.specification = v.optionalString(
      payload.specification,
      "specification",
      { max: 80 },
    );
  if (payload.unit !== undefined)
    result.unit = v.optionalString(payload.unit, "unit", { max: 16 });
  if (payload.expiry !== undefined) result.expiry = parseExpiry(payload.expiry);
  if (payload.openedOn !== undefined)
    result.openedOn =
      payload.openedOn === null || payload.openedOn === ""
        ? null
        : v.date(payload.openedOn, "openedOn");
  if (payload.afterOpenDays !== undefined) {
    result.afterOpenDays =
      payload.afterOpenDays === null
        ? null
        : v.finiteNumber(payload.afterOpenDays, "afterOpenDays", {
            min: 1,
            max: 3650,
            integer: true,
          });
  }
  if (payload.storageLocation !== undefined)
    result.storageLocation =
      v.optionalString(payload.storageLocation, "storageLocation", {
        max: 30,
      }) ?? "";
  if (payload.notes !== undefined)
    result.notes = v.optionalString(payload.notes, "notes", { max: 300 });
  return result;
}

function parseMedicationCreate(payload) {
  v.keys(payload, [
    "profileId",
    "name",
    "specification",
    "storageLocation",
    "unit",
    "expiry",
    "openedOn",
    "afterOpenDays",
    "notes",
  ]);
  const result = medicationFields(payload);
  if (result.afterOpenDays && !result.openedOn)
    invalid("填写开封后天数时必须填写开封日期");
  return result;
}

function parseMedicationUpdate(payload) {
  v.keys(payload, [
    "id",
    "expectedVersion",
    "profileId",
    "name",
    "specification",
    "storageLocation",
    "unit",
    "expiry",
    "openedOn",
    "afterOpenDays",
    "notes",
  ]);
  const patch = medicationFields(payload, { partial: true });
  if (!Object.keys(patch).length) throwInvalidPatch();
  return {
    id: v.id(payload.id),
    expectedVersion: v.expectedVersion(payload.expectedVersion),
    patch,
  };
}

function parsePlanSave(payload) {
  v.keys(payload, [
    "medicationId",
    "expectedMedicationVersion",
    "kind",
    "dose",
    "unit",
    "times",
    "weekdays",
    "startDate",
    "endDate",
    "notes",
  ]);
  const kind = v.oneOf(payload.kind, "kind", ["daily", "weekdays", "prn"]);
  const startDate = v.date(payload.startDate, "startDate");
  const endDate = payload.endDate ? v.date(payload.endDate, "endDate") : null;
  if (endDate && endDate < startDate) invalid("endDate 不能早于 startDate");
  const result = {
    medicationId: v.id(payload.medicationId, "medicationId"),
    expectedMedicationVersion: v.expectedVersion(
      payload.expectedMedicationVersion,
    ),
    kind,
    dose: v.finiteNumber(payload.dose, "dose", { min: 0.001, max: 100000 }),
    unit: v.string(payload.unit, "unit", { min: 1, max: 16 }),
    times:
      kind === "prn"
        ? []
        : v
            .uniqueArray(
              payload.times,
              "times",
              (item, label) => v.time(item, label),
              { min: 1, max: 12 },
            )
            .sort(),
    weekdays:
      kind === "weekdays"
        ? v
            .uniqueArray(
              payload.weekdays,
              "weekdays",
              (item, label) =>
                v.finiteNumber(item, label, { min: 1, max: 7, integer: true }),
              { min: 1, max: 7 },
            )
            .sort()
        : [],
    startDate,
    endDate,
    notes: v.optionalString(payload.notes, "notes", { max: 300 }),
  };
  return result;
}

function parsePlanStop(payload) {
  v.keys(payload, ["medicationId", "expectedMedicationVersion"]);
  return {
    medicationId: v.id(payload.medicationId, "medicationId"),
    expectedMedicationVersion: v.expectedVersion(
      payload.expectedMedicationVersion,
    ),
  };
}

function parseSnapshotCreate(payload) {
  v.keys(payload, ["medicationId", "quantity", "unit", "capturedAt"]);
  return {
    medicationId: v.id(payload.medicationId, "medicationId"),
    quantity: v.finiteNumber(payload.quantity, "quantity", {
      min: 0,
      max: 1000000,
    }),
    unit: v.string(payload.unit, "unit", { min: 1, max: 16 }),
    capturedAt: payload.capturedAt
      ? v.isoTimestamp(payload.capturedAt, "capturedAt")
      : null,
  };
}

function parseIntakeRecord(payload) {
  v.keys(payload, [
    "medicationId",
    "planId",
    "status",
    "scheduledAt",
    "occurredAt",
    "quantity",
    "unit",
  ]);
  const status = v.oneOf(payload.status, "status", [
    "taken",
    "skipped",
    "extra",
  ]);
  const planId = payload.planId ? v.id(payload.planId, "planId") : null;
  if (status !== "extra" && !planId) invalid("已服或未服记录必须关联计划");
  if (status !== "extra" && !payload.scheduledAt)
    invalid("已服或未服记录必须包含 scheduledAt");
  return {
    medicationId: v.id(payload.medicationId, "medicationId"),
    planId,
    status,
    scheduledAt: payload.scheduledAt
      ? v.isoTimestamp(payload.scheduledAt, "scheduledAt")
      : null,
    occurredAt: payload.occurredAt
      ? v.isoTimestamp(payload.occurredAt, "occurredAt")
      : null,
    quantity:
      status === "extra"
        ? v.finiteNumber(payload.quantity, "quantity", {
            min: 0.001,
            max: 100000,
          })
        : null,
    unit:
      status === "extra"
        ? v.string(payload.unit, "unit", { min: 1, max: 16 })
        : null,
  };
}

function parseIntakeList(payload) {
  v.keys(payload, ["medicationId", "from", "to", "cursor", "limit"]);
  const from = payload.from ? v.isoTimestamp(payload.from, "from") : null;
  const to = payload.to ? v.isoTimestamp(payload.to, "to") : null;
  if (from && to && from > to) invalid("from 不能晚于 to");
  return {
    medicationId: payload.medicationId
      ? v.id(payload.medicationId, "medicationId")
      : null,
    from,
    to,
    cursor: payload.cursor ? v.id(payload.cursor, "cursor") : null,
    limit:
      payload.limit === undefined
        ? 50
        : v.finiteNumber(payload.limit, "limit", {
            min: 1,
            max: 100,
            integer: true,
          }),
  };
}

function parseSettingsUpdate(payload) {
  v.keys(payload, [
    "expectedVersion",
    "expiryLeadDays",
    "shortageLeadDays",
    "privateCalendarTitle",
    "notificationPrivacy",
    "subscriptions",
  ]);
  const patch = {};
  if (payload.expiryLeadDays !== undefined)
    patch.expiryLeadDays = v.finiteNumber(
      payload.expiryLeadDays,
      "expiryLeadDays",
      { min: 1, max: 365, integer: true },
    );
  if (payload.shortageLeadDays !== undefined)
    patch.shortageLeadDays = v.finiteNumber(
      payload.shortageLeadDays,
      "shortageLeadDays",
      { min: 1, max: 90, integer: true },
    );
  if (payload.privateCalendarTitle !== undefined)
    patch.privateCalendarTitle = v.boolean(
      payload.privateCalendarTitle,
      "privateCalendarTitle",
    );
  if (payload.notificationPrivacy !== undefined)
    patch.notificationPrivacy = v.oneOf(
      payload.notificationPrivacy,
      "notificationPrivacy",
      ["generic", "detailed"],
    );
  if (payload.subscriptions !== undefined) {
    v.keys(payload.subscriptions, ["expiry", "shortage"], "subscriptions");
    patch.subscriptions = {
      expiry: v.boolean(payload.subscriptions.expiry, "subscriptions.expiry"),
      shortage: v.boolean(
        payload.subscriptions.shortage,
        "subscriptions.shortage",
      ),
    };
  }
  if (!Object.keys(patch).length) throwInvalidPatch();
  return { expectedVersion: v.expectedVersion(payload.expectedVersion), patch };
}

function parseAction(action, payload) {
  switch (action) {
    case "bootstrap":
    case "today.get":
    case "cabinet.get":
    case "profile.list":
    case "settings.get":
    case "data.export":
    case "account.delete":
      return parseEmpty(payload);
    case "profile.create":
      return parseProfileCreate(payload);
    case "profile.update":
      return parseProfileUpdate(payload);
    case "profile.delete":
    case "medication.archive":
    case "medication.delete":
    case "intake.undo":
      return parseIdVersion(payload);
    case "medication.get":
      return parseId(payload);
    case "medication.create":
      return parseMedicationCreate(payload);
    case "medication.update":
      return parseMedicationUpdate(payload);
    case "plan.list":
      return parseList(payload);
    case "plan.save":
      return parsePlanSave(payload);
    case "plan.stop":
      return parsePlanStop(payload);
    case "snapshot.list":
      return parseList(payload);
    case "snapshot.create":
      return parseSnapshotCreate(payload);
    case "intake.list":
      return parseIntakeList(payload);
    case "intake.record":
      return parseIntakeRecord(payload);
    case "settings.update":
      return parseSettingsUpdate(payload);
    default:
      invalid("action 不受支持");
  }
}

function invalid(message) {
  fail("INVALID_ARGUMENT", message);
}

function throwInvalidPatch() {
  invalid("至少需要提供一个可更新字段");
}

module.exports = { parseAction };
