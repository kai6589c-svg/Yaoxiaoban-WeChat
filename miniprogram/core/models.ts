import type {
  DatePrecision,
  IntakeStatus,
  MedicationMode,
  RiskType,
  ScheduleType,
} from "./status";

export type {
  CalendarSyncStatus,
  DatePrecision,
  FormState,
  IntakeStatus,
  MedicationMode,
  RiskType,
  ScheduleType,
} from "./status";

export interface AccountSettings {
  privacyAcceptedVersion: string | null;
  privacyAcceptedAt: string | null;
  notificationPrivacy: "generic" | "detailed";
  expiryLeadDays: number;
  lowStockLeadDays: number;
  timezone: "Asia/Shanghai";
  lowFrequencyReminders: boolean;
}

export interface Profile {
  id: string;
  name: string;
  relation: "self" | "parent" | "child" | "partner" | "other";
  color: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface MedicationPhoto {
  mediaId: string;
  fileId?: string;
  url?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  updatedAt: string;
}

export interface Medication {
  id: string;
  profileId: string;
  name: string;
  specification: string;
  storageLocation?: string;
  unit: string;
  mode: MedicationMode;
  expiryPrecision: DatePrecision;
  expiryValue: string;
  openedDate: string | null;
  afterOpenDays: number | null;
  note: string;
  photo: MedicationPhoto | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PlanVersion {
  id: string;
  medicationId: string;
  scheduleType: ScheduleType;
  startDate: string;
  endDate: string | null;
  weekdays: number[];
  times: string[];
  doseMilli: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  version: number;
}

export interface InventorySnapshot {
  id: string;
  medicationId: string;
  quantityMilli: number;
  recordedAt: string;
  note: string;
  createdAt: string;
  version: number;
}

export interface IntakeLog {
  id: string;
  medicationId: string;
  planId: string | null;
  occurrenceKey: string | null;
  status: IntakeStatus;
  quantityMilli: number;
  scheduledAt: string | null;
  occurredAt: string;
  requestId: string;
  voidedAt: string | null;
  createdAt: string;
  version: number;
}

export interface CalendarExport {
  id: string;
  medicationId: string;
  planId: string;
  fingerprint: string;
  eventTitle: string;
  exportedAt: string;
  staleAt: string | null;
  version: number;
}

export interface AppState {
  syncScope?: string;
  schemaVersion: 1;
  settings: AccountSettings;
  profiles: Profile[];
  medications: Medication[];
  plans: PlanVersion[];
  snapshots: InventorySnapshot[];
  intakeLogs: IntakeLog[];
  calendarExports: CalendarExport[];
  updatedAt: string;
}

export interface MedicationDraft {
  id?: string;
  profileId: string;
  name: string;
  specification: string;
  storageLocation?: string;
  unit: string;
  mode: MedicationMode;
  expiryPrecision: DatePrecision;
  expiryValue: string;
  openedDate: string | null;
  afterOpenDays: number | null;
  note: string;
  expectedVersion?: number;
  initialQuantityMilli?: number | null;
  schedule?: {
    type: ScheduleType;
    startDate: string;
    endDate: string | null;
    weekdays: number[];
    times: string[];
    doseMilli: number;
  } | null;
}

export interface ScheduleOccurrence {
  key: string;
  medicationId: string;
  planId: string;
  scheduledAt: string;
  scheduledAtMs: number;
  localDate: string;
  time: string;
  doseMilli: number;
}

export interface InventoryEstimate {
  medicationId: string;
  asOf: string;
  snapshotAt: string | null;
  currentQuantityMilli: number | null;
  lastCoveredAt: string | null;
  firstShortageAt: string | null;
  predictable: boolean;
  reason: "ok" | "no-snapshot" | "no-plan" | "as-needed" | "plan-ended";
}

export interface TodayTask extends ScheduleOccurrence {
  medicationName: string;
  profileName: string;
  profileColor: string;
  unit: string;
  status: "upcoming" | "due" | "taken" | "skipped" | "needs-review";
  logId: string | null;
}

export interface RiskItem {
  id: string;
  medicationId: string;
  level: "danger" | "warning" | "info";
  type: RiskType;
  title: string;
  detail: string;
}
