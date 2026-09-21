"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CompatibilityService } = require("../lib/compat-service");
const { MedicineService } = require("../lib/service");
const { MemoryStore } = require("./support/memory-store");

test("前端 DataService 契约返回完整 AppState 和 milli 单位", async () => {
  let instant = new Date("2026-08-19T00:00:00.000Z");
  const store = new MemoryStore();
  const medicineService = new MedicineService(store, {
    clock: () => instant,
    logger: { warn() {} },
  });
  const compat = new CompatibilityService(store, medicineService, {
    clock: () => instant,
  });
  const accountId = "acct_compat";
  const context = (requestId) => ({ accountId, requestId });

  let state = await compat.execute("bootstrap", {}, context(null));
  assert.deepEqual(Object.keys(state).sort(), [
    "calendarExports",
    "intakeLogs",
    "medications",
    "plans",
    "profiles",
    "schemaVersion",
    "settings",
    "snapshots",
    "updatedAt",
  ]);
  state = await compat.execute(
    "acceptPrivacy",
    { version: "2026-08-01" },
    context("privacy-0000001"),
  );
  assert.equal(state.settings.privacyAcceptedVersion, "2026-08-01");

  const saved = await compat.execute(
    "saveMedication",
    {
      id: null,
      profileId: state.profiles[0].id,
      name: "测试药",
      specification: "10mg",
      unit: "片",
      mode: "scheduled",
      expiryPrecision: "month",
      expiryValue: "2027-06",
      openedDate: null,
      afterOpenDays: null,
      note: "",
      expectedVersion: null,
      initialQuantityMilli: 10000,
      schedule: {
        type: "daily",
        startDate: "2026-08-19",
        endDate: null,
        weekdays: [],
        times: ["09:00"],
        doseMilli: 1000,
      },
    },
    context("save-med-0000001"),
  );
  assert.equal(saved.state.medications[0].unit, "片");
  assert.equal(saved.state.snapshots[0].quantityMilli, 10000);
  assert.equal(saved.state.plans[0].doseMilli, 1000);
  assert.equal(saved.medicationId, saved.state.medications[0].id);
  assert.equal(saved.planId, saved.state.plans[0].id);

  instant = new Date("2026-08-19T02:00:00.000Z");
  state = await compat.execute(
    "recordIntake",
    {
      medicationId: saved.medicationId,
      planId: saved.planId,
      occurrenceKey: `${saved.planId}|2026-08-19|09:00`,
      scheduledAt: "2026-08-19T01:00:00.000Z",
      status: "taken",
      quantityMilli: 1000,
      occurredAt: null,
      requestId: "take-compat-0001",
    },
    context("take-compat-0001"),
  );
  assert.equal(state.intakeLogs[0].quantityMilli, 1000);
  assert.equal(state.intakeLogs[0].requestId, "take-compat-0001");

  await assert.rejects(
    compat.execute(
      "recordIntakeQueued",
      {
        medicationId: saved.medicationId,
        planId: saved.planId,
        occurrenceKey: `${saved.planId}|2026-08-19|09:00`,
        scheduledAt: "2026-08-19T01:00:00.000Z",
        status: "skipped",
        quantityMilli: 1000,
        occurredAt: null,
        requestId: "offline-other-device",
      },
      context("offline-other-device"),
    ),
    (error) => error.code === "CONFLICT",
  );
  assert.equal(
    (await compat.getAppState(accountId)).intakeLogs[0].status,
    "taken",
  );

  state = await compat.execute(
    "saveCalendarExport",
    {
      medicationId: saved.medicationId,
      planId: saved.planId,
      fingerprint: "fingerprint-1",
      eventTitle: "药小伴服药提醒",
    },
    context("calendar-0000001"),
  );
  assert.equal(state.calendarExports.length, 1);

  state = await compat.execute(
    "updateSettings",
    {
      notificationPrivacy: "detailed",
      expiryLeadDays: 90,
      lowStockLeadDays: 14,
      lowFrequencyReminders: true,
    },
    context("settings-0000001"),
  );
  assert.equal(state.settings.notificationPrivacy, "detailed");
  assert.equal(state.settings.lowFrequencyReminders, true);

  const exported = await compat.execute("exportData", {}, context(null));
  assert.equal(typeof exported, "string");
  assert.equal(JSON.parse(exported).data.medications[0].name, "测试药");

  state = await compat.execute(
    "archiveMedication",
    {
      id: saved.medicationId,
      expectedVersion: state.medications[0].version,
    },
    context("archive-med-00001"),
  );
  assert.ok(state.medications[0].archivedAt);
  assert.ok(
    state.plans[0].effectiveTo,
    "归档必须停止旧计划，避免恢复后重新生成任务",
  );

  state = await compat.execute(
    "restoreMedication",
    {
      id: saved.medicationId,
      expectedVersion: state.medications[0].version,
    },
    context("restore-med-00001"),
  );
  assert.equal(state.medications[0].archivedAt, null);
  assert.equal(state.medications[0].mode, "expiry_only");
  assert.ok(state.plans[0].effectiveTo, "恢复不能复活旧计划");

  state = await compat.execute(
    "deleteMedication",
    {
      id: saved.medicationId,
      expectedVersion: state.medications[0].version,
    },
    context("delete-med-000001"),
  );
  assert.equal(state.medications.length, 0);
  assert.equal(state.plans.length, 0);
  assert.equal(state.snapshots.length, 0);
  assert.equal(state.intakeLogs.length, 0);
  assert.equal(state.calendarExports.length, 0);
});

test("storage location round trips through normal/fast saves and survives an older client edit", async () => {
  const store = new MemoryStore();
  const clock = () => new Date("2026-09-16T00:00:00Z");
  const compat = new CompatibilityService(
    store,
    new MedicineService(store, { clock, logger: { warn() {} } }),
    { clock },
  );
  const context = (requestId) => ({ accountId: "acct_location", requestId });
  await compat.execute("bootstrap", {}, context(null));
  const state = await compat.execute(
    "acceptPrivacy",
    { version: "2026-08-01" },
    context("location-privacy-001"),
  );
  const draft = {
    profileId: state.profiles[0].id,
    name: "药盒",
    specification: "10mg",
    unit: "片",
    mode: "expiry_only",
    expiryPrecision: "day",
    expiryValue: "2027-01-01",
    openedDate: null,
    afterOpenDays: null,
    note: "",
    schedule: null,
  };
  const saved = await compat.execute(
    "saveMedication",
    { ...draft, storageLocation: "客厅" },
    context("location-create-001"),
  );
  let med = saved.state.medications[0];
  assert.equal(med.storageLocation, "客厅");
  const updated = await compat.execute(
    "saveMedicationFast",
    { ...draft, id: med.id, expectedVersion: med.version, name: "更新药盒" },
    context("location-update-001"),
  );
  med = updated.medication;
  assert.equal(med.storageLocation, "客厅");
  const cleared = await compat.execute(
    "saveMedicationFast",
    { ...draft, id: med.id, expectedVersion: med.version, storageLocation: "" },
    context("location-clear-001"),
  );
  assert.equal(cleared.medication.storageLocation, "");
  const { parseCompatAction } = require("../lib/compat-schemas");
  assert.throws(
    () =>
      parseCompatAction("saveMedication", {
        ...draft,
        storageLocation: "长".repeat(31),
      }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});
