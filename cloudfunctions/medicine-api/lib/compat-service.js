"use strict";

const { fail } = require("./errors");
const { calculateEffectiveExpiry, effectiveExpiry } = require("./domain");
const { deterministicId } = require("./hash");
const { PRIVACY_VERSION } = require("./constants");
const { chinaDate } = require("./time");

class CompatibilityService {
  constructor(store, medicineService, options = {}) {
    this.store = store;
    this.medicineService = medicineService;
    this.clock = options.clock ?? (() => new Date());
  }

  now() {
    return this.clock().toISOString();
  }

  async execute(action, payload, context) {
    switch (action) {
      case "getTodayDashboard": {
        const state = await this.getAppState(context.accountId, {
          includePhotos: false,
        });
        return require("./dashboard-shared").buildTodayDashboard(
          state,
          this.clock().getTime(),
        );
      }
      case "bootstrap":
        const bootstrap = await this.medicineService.bootstrap(context);
        if (bootstrap.settings.privacyAcceptedVersion !== PRIVACY_VERSION) {
          return {
            schemaVersion: 1,
            settings: toSettings(bootstrap.settings),
            profiles: [],
            medications: [],
            plans: [],
            snapshots: [],
            intakeLogs: [],
            calendarExports: [],
            updatedAt: bootstrap.settings.updatedAt,
          };
        }
        return this.getAppState(context.accountId);
      case "acceptPrivacy":
        return this.acceptPrivacy(payload, context);
      case "upsertProfile":
        return this.upsertProfile(payload, context);
      case "archiveProfile":
        return this.archiveProfile(payload, context);
      case "saveMedicationFast":
        return this.saveMedication(payload, context, true);
      case "saveMedication":
        return this.saveMedication(payload, context);
      case "archiveMedication":
        return this.archiveMedication(payload, context);
      case "restoreMedication":
        return this.restoreMedication(payload, context);
      case "deleteMedication":
        return this.deleteMedication(payload, context);
      case "putMedicationPhotoChunk":
        return require("./photo-chunks").putPhotoChunk(
          this.medicineService,
          payload,
          context,
        );
      case "completeMedicationPhotoUpload": {
        const medication = await require("./photo-chunks").completePhotoChunks(
          this.medicineService,
          payload,
          context,
        );
        return toMedication(medication);
      }
      case "finishMedicationPhotoUpload":
        return require("./photo-chunks").finishPhotoChunks(
          this.medicineService,
          payload,
          context,
        );
      case "uploadMedicationPhoto":
        return this.medicineService.uploadMedicationPhoto(payload, context);
      case "processMedicationPhoto":
        await this.store.getOwned(
          "medications",
          payload.medicationId,
          context.accountId,
        );
        await this.medicineService.cleanupPendingMedia(
          context,
          payload.medicationId,
        );
        return { processed: true };
      case "prepareMedicationPhoto":
        return this.medicineService.prepareMedicationPhoto(payload, context);
      case "commitMedicationPhoto":
        return this.commitMedicationPhoto(payload, context);
      case "removeMedicationPhoto":
        return this.removeMedicationPhoto(payload, context);
      case "discardMedicationPhoto":
        return this.medicineService.discardMedicationPhoto(payload, context);
      case "getMedicationPhotoStatus":
        return this.medicineService.getMedicationPhotoStatus(payload, context);
      case "recordSubscriptionGrant":
        return this.recordSubscriptionGrant(payload, context);
      case "getReminderStatus":
        return this.getReminderStatus(payload, context);
      case "updateReminderSettings":
        return this.updateReminderSettings(payload, context);
      case "confirmInventory":
        return this.confirmInventory(payload, context);
      case "recordIntakeQueued":
        return this.recordIntake(payload, context, true);
      case "recordIntake":
        return this.recordIntake(payload, context);
      case "undoIntake":
        return this.undoIntake(payload, context);
      case "saveCalendarExport":
        return this.saveCalendarExport(payload, context);
      case "updateSettings":
        return this.updateSettings(payload, context);
      case "exportData":
        return this.exportData(context);
      default:
        fail("INVALID_ARGUMENT", "action 不受支持");
    }
  }

  async acceptPrivacy(payload, context) {
    const current = await this.store.ensureSettings(
      context.accountId,
      this.now(),
    );
    await this.store.updateOwnedVersioned(
      "settings",
      current._id,
      context.accountId,
      current.version,
      {
        privacyAcceptedVersion: payload.version,
        privacyAcceptedAt: this.now(),
      },
      this.now(),
      context.requestId,
    );
    await this.ensureActiveProfile(context);
    return this.getAppState(context.accountId);
  }

  async upsertProfile(payload, context) {
    if (payload.id) {
      const current = await this.store.getOwned(
        "profiles",
        payload.id,
        context.accountId,
      );
      if (current.archivedAt) fail("NOT_FOUND", "成员不存在");
      await this.medicineService.updateProfile(
        {
          id: payload.id,
          expectedVersion: payload.expectedVersion,
          patch: {
            displayName: payload.name,
            relation: payload.relation,
            color: payload.color,
          },
        },
        context,
      );
    } else {
      await this.medicineService.createProfile(
        {
          displayName: payload.name,
          relation: payload.relation,
          color: payload.color,
        },
        context,
      );
    }
    return this.getAppState(context.accountId);
  }

  async archiveProfile(payload, context) {
    const profile = await this.store.getOwned(
      "profiles",
      payload.id,
      context.accountId,
    );
    if (profile.version !== payload.expectedVersion) {
      fail("VERSION_CONFLICT", "资料已更新，请刷新后重试", {
        currentVersion: profile.version,
      });
    }
    const activeProfiles = (
      await this.store.listAllOwned("profiles", context.accountId)
    ).filter((item) => !item.archivedAt);
    if (activeProfiles.length <= 1) fail("LAST_PROFILE", "至少保留一位成员");
    const activeMedications = await this.store.listAllOwned(
      "medications",
      context.accountId,
      {
        profileId: payload.id,
        status: "active",
      },
    );
    if (activeMedications.length)
      fail("PROFILE_IN_USE", "请先移除该成员名下的药盒");
    await this.store.updateOwnedVersioned(
      "profiles",
      payload.id,
      context.accountId,
      payload.expectedVersion,
      { archivedAt: this.now() },
      this.now(),
      context.requestId,
    );
    return this.getAppState(context.accountId);
  }

  async saveMedication(draft, context, compact = false) {
    const expiryResolution = calculateEffectiveExpiry(medicationPatch(draft));
    const packageExpiry = expiryResolution.packageDate;
    const effectiveExpiryDate = expiryResolution.effectiveDate;
    if (draft.openedDate && draft.openedDate > chinaDate(this.clock()))
      fail("INVALID_ARGUMENT", "开启日期不能晚于今天");
    if (draft.openedDate && draft.openedDate > packageExpiry)
      fail("INVALID_ARGUMENT", "开启日期不能晚于包装有效期");
    if (draft.schedule?.startDate > effectiveExpiryDate)
      fail("INVALID_ARGUMENT", "计划开始日期不能晚于管理期限");
    if (draft.schedule?.endDate && draft.schedule.endDate > effectiveExpiryDate)
      fail("INVALID_ARGUMENT", "计划结束日期不能晚于管理期限");

    let medication;
    let planChanged = draft.mode !== "expiry_only" && Boolean(draft.schedule);
    let calendarMetadataChanged = false;
    if (draft.id) {
      medication = await this.store.getOwned(
        "medications",
        draft.id,
        context.accountId,
      );
      if (medication.version !== draft.expectedVersion) {
        fail("VERSION_CONFLICT", "药品已在其他设备更新，请刷新后重试", {
          currentVersion: medication.version,
        });
      }
      const previousEffectiveExpiry = effectiveExpiry(medication);
      if (previousEffectiveExpiry !== effectiveExpiryDate) {
        calendarMetadataChanged = true;
      } else if (medication.name !== draft.name) {
        const settings = await this.store.ensureSettings(
          context.accountId,
          this.now(),
        );
        calendarMetadataChanged = !settings.privateCalendarTitle;
      }
      if ((medication.unit ?? "") !== draft.unit) {
        const [plans, snapshots, logs] = await Promise.all([
          this.store.listAllOwned("plans", context.accountId, {
            medicationId: medication._id,
          }),
          this.store.listAllOwned("snapshots", context.accountId, {
            medicationId: medication._id,
          }),
          this.store.listAllOwned("intakeLogs", context.accountId, {
            medicationId: medication._id,
          }),
        ]);
        if (plans.length || snapshots.length || logs.length)
          fail(
            "INVALID_ARGUMENT",
            "已有计划、盘点或使用记录，不能直接修改单位；请新建另一盒",
          );
      }
      const activePlan = medication.activePlanId
        ? await this.store.getOwned(
            "plans",
            medication.activePlanId,
            context.accountId,
            { required: false },
          )
        : null;
      planChanged = !sameDraftPlan(activePlan, draft, medication.unit ?? "");
      if (medication.activePlanId && planChanged) {
        const stopped = await this.medicineService.stopPlan(
          {
            medicationId: medication._id,
            expectedMedicationVersion: medication.version,
          },
          context,
        );
        medication = stopped.medication;
      }
      medication = await this.medicineService.updateMedication(
        {
          id: medication._id,
          expectedVersion: medication.version,
          patch: medicationPatch(draft),
        },
        context,
      );
      if (!planChanged && activePlan && calendarMetadataChanged) {
        await this.store.markCalendarExportsStale(
          context.accountId,
          medication._id,
          this.now(),
        );
      }
    } else {
      medication = await this.medicineService.createMedication(
        medicationPatch(draft),
        context,
      );
    }

    let planId = null;
    if (planChanged && draft.mode !== "expiry_only" && draft.schedule) {
      const saved = await this.medicineService.savePlan(
        {
          medicationId: medication._id,
          expectedMedicationVersion: medication.version,
          kind:
            draft.schedule.type === "weekly"
              ? "weekdays"
              : draft.schedule.type === "as_needed"
                ? "prn"
                : "daily",
          dose: draft.schedule.doseMilli / 1000,
          unit: draft.unit,
          times: draft.schedule.times,
          weekdays: draft.schedule.weekdays,
          startDate: draft.schedule.startDate,
          endDate: draft.schedule.endDate,
          notes: null,
        },
        context,
      );
      medication = saved.medication;
      planId = saved.plan._id;
    }

    if (draft.initialQuantityMilli !== null) {
      await this.medicineService.createSnapshot(
        {
          medicationId: medication._id,
          quantity: draft.initialQuantityMilli / 1000,
          unit: draft.unit,
          capturedAt: this.now(),
          note: draft.id ? "编辑药品时重新盘点" : "首次添加",
        },
        context,
      );
    }
    if (compact) {
      const current = await this.store.getOwned(
        "medications",
        medication._id,
        context.accountId,
      );
      let photoTicket;
      if (draft.preparePhoto) {
        try {
          photoTicket = await this.medicineService.prepareMedicationPhoto(
            { medicationId: current._id, expectedVersion: current.version },
            context,
          );
        } catch {
          // Fields are confirmed even when ticket creation needs a separate retry.
        }
      }
      return {
        ...(photoTicket ? { photoTicket } : {}),
        medication: toMedication(
          await this.medicineService.publicMedication(current),
        ),
        planId,
      };
    }
    const state = await this.getAppState(context.accountId);
    return { state, medicationId: medication._id, planId };
  }

  async archiveMedication(payload, context) {
    await this.medicineService.archiveMedication(payload, context);
    return this.getAppState(context.accountId);
  }

  async restoreMedication(payload, context) {
    const medication = await this.store.getOwned(
      "medications",
      payload.id,
      context.accountId,
    );
    if (medication.version !== payload.expectedVersion)
      fail("VERSION_CONFLICT", "药盒已更新，请刷新后重试");
    if (medication.status !== "archived")
      fail("INVALID_ARGUMENT", "这个药盒没有移除");
    await this.medicineService.updateMedication(
      {
        id: medication._id,
        expectedVersion: medication.version,
        patch: {
          status: "active",
          archivedAt: null,
          activePlanId: null,
          mode: "expiry_only",
        },
      },
      context,
    );
    return this.getAppState(context.accountId);
  }

  async deleteMedication(payload, context) {
    await this.medicineService.deleteMedication(payload, context);
    return this.getAppState(context.accountId);
  }

  async commitMedicationPhoto(payload, context) {
    await this.medicineService.commitMedicationPhoto(payload, context);
    return this.getAppState(context.accountId);
  }

  async removeMedicationPhoto(payload, context) {
    await this.medicineService.removeMedicationPhoto(payload, context);
    return this.getAppState(context.accountId);
  }

  async confirmInventory(payload, context) {
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    if (medication.status !== "active") fail("NOT_FOUND", "药品不存在");
    if (!medication.unit) fail("UNIT_MISMATCH", "请先为药品设置数量单位");
    await this.medicineService.createSnapshot(
      {
        medicationId: payload.medicationId,
        quantity: payload.quantityMilli / 1000,
        unit: medication.unit,
        capturedAt: payload.recordedAt,
        note: payload.note,
      },
      context,
    );
    return this.getAppState(context.accountId);
  }

  async recordIntake(payload, context, createOnly = false) {
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    const result = await this.medicineService.recordIntake(
      {
        medicationId: payload.medicationId,
        planId: payload.planId,
        occurrenceKey: payload.occurrenceKey,
        scheduledAt: payload.scheduledAt,
        status: payload.status,
        quantity: payload.quantityMilli / 1000,
        unit: medication.unit || null,
        occurredAt: payload.occurredAt,
      },
      context,
      createOnly,
    );
    if (!result.requestId) {
      await this.store.updateOwnedVersioned(
        "intakeLogs",
        result._id,
        context.accountId,
        result.version,
        {
          requestId: payload.requestId ?? context.requestId,
          occurrenceKey: payload.occurrenceKey,
        },
        this.now(),
        context.requestId,
      );
    }
    return this.getAppState(context.accountId);
  }

  async undoIntake(payload, context) {
    await this.medicineService.undoIntake(
      { id: payload.logId, expectedVersion: payload.expectedVersion },
      context,
    );
    return this.getAppState(context.accountId);
  }

  async saveCalendarExport(payload, context) {
    const medication = await this.store.getOwned(
      "medications",
      payload.medicationId,
      context.accountId,
    );
    const plan = await this.store.getOwned(
      "plans",
      payload.planId,
      context.accountId,
    );
    if (plan.medicationId !== medication._id)
      fail("INVALID_ARGUMENT", "计划不属于该药品");
    const current = (
      await this.store.listAllOwned("calendarExports", context.accountId, {
        fingerprint: payload.fingerprint,
      })
    ).find((item) => !item.staleAt);
    if (!current) {
      const now = this.now();
      await this.store.createOwned("calendarExports", {
        _id: deterministicId("calendar", context.accountId, context.requestId),
        accountId: context.accountId,
        medicationId: medication._id,
        planId: plan._id,
        fingerprint: payload.fingerprint,
        eventTitle: payload.eventTitle,
        exportedAt: now,
        staleAt: null,
        version: 1,
        lastRequestId: context.requestId,
        createdAt: now,
        updatedAt: now,
      });
    }
    return this.getAppState(context.accountId);
  }

  async updateSettings(payload, context) {
    const current = await this.store.ensureSettings(
      context.accountId,
      this.now(),
    );
    const patch = {};
    if (payload.notificationPrivacy !== undefined)
      patch.notificationPrivacy = payload.notificationPrivacy;
    patch.privateCalendarTitle = payload.notificationPrivacy === "generic";
    if (payload.expiryLeadDays !== undefined)
      patch.expiryLeadDays = payload.expiryLeadDays;
    if (payload.lowStockLeadDays !== undefined)
      patch.shortageLeadDays = payload.lowStockLeadDays;
    if (payload.lowFrequencyReminders !== undefined) {
      patch.subscriptions = {
        expiry: payload.lowFrequencyReminders,
        shortage: payload.lowFrequencyReminders,
      };
      patch.reminderPreferences = {
        ...(current.reminderPreferences ?? {
          dose: false,
          expiry: false,
          shortage: false,
        }),
        expiry: payload.lowFrequencyReminders,
        shortage: payload.lowFrequencyReminders,
      };
    }
    const privacyChanged =
      payload.notificationPrivacy !== undefined &&
      current.privateCalendarTitle !==
        (payload.notificationPrivacy === "generic");
    await this.medicineService.updateSettings(
      { expectedVersion: current.version, patch },
      context,
    );
    if (privacyChanged) {
      const medications = await this.store.listAllOwned(
        "medications",
        context.accountId,
      );
      const now = this.now();
      await Promise.all(
        medications.map((medication) =>
          this.store.markCalendarExportsStale(
            context.accountId,
            medication._id,
            now,
          ),
        ),
      );
    }
    return this.getAppState(context.accountId);
  }

  async recordSubscriptionGrant(payload, context) {
    const now = this.now();
    const document = {
      _id: deterministicId(
        "grant",
        context.accountId,
        payload.kind,
        payload.templateId,
        context.requestId,
      ),
      accountId: context.accountId,
      kind: payload.kind,
      templateId: payload.templateId,
      authorizedMedicationId: payload.medicationId ?? null,
      version: 1,
      status: payload.status,
      usableCount: payload.status === "accept" ? 1 : 0,
      grantedAt: now,
      createdAt: now,
      updatedAt: now,
      lastRequestId: context.requestId,
    };
    const saved = await this.store.recordSubscriptionGrant(
      context.accountId,
      document,
    );
    if (payload.status === "accept") {
      const settings = await this.store.ensureSettings(context.accountId, now);
      const preferences = {
        ...(settings.reminderPreferences ?? {
          dose: false,
          expiry: false,
          shortage: false,
        }),
        [payload.kind]: true,
      };
      await this.medicineService.updateSettings(
        {
          expectedVersion: settings.version,
          patch: {
            reminderPreferences: preferences,
            ...(payload.kind === "dose"
              ? {}
              : {
                  subscriptions: {
                    ...(settings.subscriptions ?? {}),
                    [payload.kind]: true,
                  },
                }),
          },
        },
        context,
      );
    }
    return {
      kind: payload.kind,
      templateId: payload.templateId,
      status: saved.status,
      usableCount: saved.usableCount,
    };
  }

  async getReminderStatus(payload, context) {
    const [settings, grants, tasks] = await Promise.all([
      this.store.ensureSettings(context.accountId, this.now()),
      this.store.listSubscriptionGrants(context.accountId),
      this.store.listAllOwned("reminderTasks", context.accountId),
    ]);
    const filteredTasks = payload.medicationId
      ? tasks.filter((task) => task.medicationId === payload.medicationId)
      : tasks;
    const grantStatus = ["dose", "expiry", "shortage"].reduce(
      (result, kind) => {
        const kindGrants = grants.filter((item) => item.kind === kind);
        result[kind] = {
          usableCount: kindGrants.reduce(
            (sum, item) => sum + (item.usableCount ?? 0),
            0,
          ),
          accepted: kindGrants.some((item) => item.status === "accept"),
        };
        return result;
      },
      {},
    );
    return {
      preferences: settings.reminderPreferences ?? {
        dose: false,
        expiry: false,
        shortage: false,
      },
      grants: grantStatus,
      tasks: filteredTasks.map((task) => ({
        id: task._id,
        kind: task.kind,
        status: task.status,
        dueAt: task.dueAt,
        sentAt: task.sentAt ?? null,
        failureCode: task.failureCode ?? null,
        attemptCount: task.attemptCount ?? task.attempts ?? 0,
        lastAttemptAt: task.lastAttemptAt ?? null,
        nextAttemptAt: task.nextAttemptAt ?? null,
      })),
    };
  }

  async updateReminderSettings(payload, context) {
    const current = await this.store.ensureSettings(
      context.accountId,
      this.now(),
    );
    const preferences = {
      ...(current.reminderPreferences ?? {
        dose: false,
        expiry: false,
        shortage: false,
      }),
      [payload.kind]: payload.enabled,
    };
    const patch = { reminderPreferences: preferences };
    if (payload.kind === "expiry" && payload.leadDays !== null)
      patch.expiryLeadDays = payload.leadDays;
    if (payload.kind === "shortage" && payload.leadDays !== null)
      patch.shortageLeadDays = payload.leadDays;
    await this.medicineService.updateSettings(
      { expectedVersion: current.version, patch },
      context,
    );
    if (!payload.enabled) {
      const medications = await this.store.listAllOwned(
        "medications",
        context.accountId,
      );
      await Promise.all(
        medications.map((item) =>
          this.store.cancelReminderTasks(
            context.accountId,
            item._id,
            this.now(),
          ),
        ),
      );
    }
    return this.getAppState(context.accountId);
  }

  async exportData(context) {
    const data = await this.getAppState(context.accountId);
    return JSON.stringify(
      {
        app: "药小伴",
        exportedAt: this.now(),
        notice: "本文件包含私人服药记录，请妥善保管。",
        data,
      },
      null,
      2,
    );
  }

  async ensureActiveProfile(context) {
    const profiles = await this.store.listAllOwned(
      "profiles",
      context.accountId,
    );
    if (profiles.some((item) => !item.archivedAt)) return;
    const archivedSelf = profiles.find((item) => item.relation === "self");
    if (archivedSelf) {
      await this.store.updateOwnedVersioned(
        "profiles",
        archivedSelf._id,
        context.accountId,
        archivedSelf.version,
        { archivedAt: null },
        this.now(),
        context.requestId,
      );
      return;
    }
    await this.medicineService.createProfile(
      { displayName: "我", relation: "self", color: "#4E8D70" },
      context,
    );
  }

  async getAppState(accountId, { includePhotos = true } = {}) {
    const now = this.now();
    const [
      settings,
      profiles,
      medications,
      plans,
      snapshots,
      intakeLogs,
      calendarExports,
    ] = await Promise.all([
      this.store.ensureSettings(accountId, now),
      this.store.listAllOwned("profiles", accountId),
      this.store.listAllOwned("medications", accountId),
      this.store.listAllOwned("plans", accountId),
      this.store.listAllOwned("snapshots", accountId),
      this.store.listAllOwned("intakeLogs", accountId),
      this.store.listAllOwned("calendarExports", accountId),
    ]);
    const updatedAt =
      [
        settings,
        ...profiles,
        ...medications,
        ...plans,
        ...snapshots,
        ...intakeLogs,
        ...calendarExports,
      ]
        .map((item) => item.updatedAt ?? item.createdAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? now;
    return {
      schemaVersion: 1,
      syncScope: accountId,
      settings: toSettings(settings),
      profiles: profiles.map(toProfile).sort(byCreated),
      medications: (
        await Promise.all(
          medications.map(async (item) =>
            toMedication(
              includePhotos
                ? await this.medicineService.publicMedication(item)
                : { ...item, photo: null },
            ),
          ),
        )
      ).sort(byCreated),
      plans: plans.map(toPlan).sort(byCreated),
      snapshots: snapshots.map(toSnapshot).sort(byCreated),
      intakeLogs: intakeLogs.map(toIntake).sort(byCreated),
      calendarExports: calendarExports.map(toCalendar).sort(byCreated),
      updatedAt,
    };
  }
}

function medicationPatch(draft) {
  return {
    profileId: draft.profileId,
    name: draft.name,
    specification: draft.specification,
    ...(draft.storageLocation !== undefined
      ? { storageLocation: draft.storageLocation }
      : {}),
    unit: draft.unit || null,
    mode: draft.mode,
    expiry: { precision: draft.expiryPrecision, value: draft.expiryValue },
    openedOn: draft.openedDate,
    afterOpenDays: draft.afterOpenDays,
    notes: draft.note,
  };
}

function sameDraftPlan(plan, draft, currentUnit) {
  if (draft.mode === "expiry_only" || !draft.schedule) return !plan;
  if (!plan || currentUnit !== draft.unit) return false;
  const kind =
    draft.schedule.type === "weekly"
      ? "weekdays"
      : draft.schedule.type === "as_needed"
        ? "prn"
        : "daily";
  return (
    plan.kind === kind &&
    plan.startDate === draft.schedule.startDate &&
    (plan.endDate ?? null) === draft.schedule.endDate &&
    Math.round(plan.dose * 1000) === draft.schedule.doseMilli &&
    JSON.stringify([...(plan.weekdays ?? [])].sort((a, b) => a - b)) ===
      JSON.stringify([...draft.schedule.weekdays].sort((a, b) => a - b)) &&
    JSON.stringify([...(plan.times ?? [])].sort()) ===
      JSON.stringify([...draft.schedule.times].sort())
  );
}

function toSettings(item) {
  return {
    privacyAcceptedVersion: item.privacyAcceptedVersion ?? null,
    privacyAcceptedAt: item.privacyAcceptedAt ?? null,
    notificationPrivacy:
      item.notificationPrivacy ??
      (item.privateCalendarTitle === false ? "detailed" : "generic"),
    expiryLeadDays: item.expiryLeadDays ?? 30,
    lowStockLeadDays: item.shortageLeadDays ?? 7,
    timezone: "Asia/Shanghai",
    lowFrequencyReminders: Boolean(
      item.subscriptions?.expiry || item.subscriptions?.shortage,
    ),
  };
}

function toProfile(item) {
  return {
    id: item._id,
    name: item.displayName,
    relation: item.relation,
    color: item.color ?? "#4E8D70",
    archivedAt: item.archivedAt ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    version: item.version,
  };
}

function toMedication(item) {
  return {
    id: item._id,
    profileId: item.profileId,
    name: item.name,
    specification: item.specification ?? "",
    storageLocation: item.storageLocation ?? "",
    unit: item.unit ?? "",
    mode: item.mode ?? (item.activePlanId ? "scheduled" : "expiry_only"),
    expiryPrecision: item.expiry?.precision ?? "day",
    expiryValue: item.expiry?.value ?? "",
    openedDate: item.openedOn ?? null,
    afterOpenDays: item.afterOpenDays ?? null,
    note: item.notes ?? "",
    photo: item.photo ?? null,
    archivedAt:
      item.archivedAt ?? (item.status !== "active" ? item.updatedAt : null),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    version: item.version,
  };
}

function toPlan(item) {
  return {
    id: item._id,
    medicationId: item.medicationId,
    scheduleType:
      item.kind === "weekdays"
        ? "weekly"
        : item.kind === "prn"
          ? "as_needed"
          : "daily",
    startDate: item.startDate,
    endDate: item.endDate ?? null,
    weekdays: item.weekdays ?? [],
    times: item.times ?? [],
    doseMilli: Math.round(item.dose * 1000),
    effectiveFrom: item.effectiveFrom,
    effectiveTo: item.supersededAt ?? null,
    createdAt: item.createdAt,
    version: item.version,
  };
}

function toSnapshot(item) {
  return {
    id: item._id,
    medicationId: item.medicationId,
    quantityMilli: Math.round(item.quantity * 1000),
    recordedAt: item.capturedAt,
    note: item.note ?? "手动盘点",
    createdAt: item.createdAt,
    version: item.version,
  };
}

function toIntake(item) {
  return {
    id: item._id,
    medicationId: item.medicationId,
    planId: item.planId ?? null,
    occurrenceKey: item.occurrenceKey ?? null,
    status: item.status,
    quantityMilli: Math.round(item.quantity * 1000),
    scheduledAt: item.scheduledAt ?? null,
    occurredAt: item.occurredAt,
    requestId: item.requestId ?? item.lastRequestId ?? item._id,
    voidedAt: item.undoneAt ?? null,
    createdAt: item.createdAt,
    version: item.version,
  };
}

function toCalendar(item) {
  return {
    id: item._id,
    medicationId: item.medicationId,
    planId: item.planId,
    fingerprint: item.fingerprint,
    eventTitle: item.eventTitle,
    exportedAt: item.exportedAt,
    staleAt: item.staleAt ?? null,
    version: item.version,
  };
}

function byCreated(a, b) {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

module.exports = { CompatibilityService, medicationPatch, toSettings };
