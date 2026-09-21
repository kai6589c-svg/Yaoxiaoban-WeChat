import { expect, it } from "vitest";
import { buildPlanPreview } from "../miniprogram/core/plan-preview";
import { localDateTimeToMs } from "../miniprogram/core/dates";
import type { MedicationDraft } from "../miniprogram/core/models";
const draft: MedicationDraft = {
  profileId: "p1",
  name: "测试",
  specification: "",
  unit: "片",
  mode: "scheduled",
  expiryPrecision: "month",
  expiryValue: "2026-09",
  openedDate: null,
  afterOpenDays: null,
  note: "",
  schedule: {
    type: "daily",
    startDate: "2026-09-01",
    endDate: null,
    weekdays: [],
    times: ["08:00", "20:00"],
    doseMilli: 1000,
  },
};
it("previews seven local dates, excluding passed times and respecting month expiry", () => {
  const result = buildPlanPreview(
    draft,
    localDateTimeToMs("2026-09-28", "09:00"),
  );
  expect(result.days.map((x) => x.date)).toEqual([
    "2026-09-28",
    "2026-09-29",
    "2026-09-30",
  ]);
  expect(result.days[0]?.text).not.toContain("08:00");
  expect(result.days[1]?.text).toContain("08:00");
});
it("weekly plan is filtered by weekday across month boundaries", () => {
  const result = buildPlanPreview(
    {
      ...draft,
      expiryValue: "2026-12",
      schedule: {
        ...draft.schedule!,
        type: "weekly",
        weekdays: [1],
        startDate: "2026-09-01",
      },
    },
    localDateTimeToMs("2026-09-29", "09:00"),
  );
  expect(result.days.map((x) => x.date)).toEqual(["2026-10-05"]);
});
it("invalid schedule shows a reason; as-needed never creates occurrences", () => {
  expect(
    buildPlanPreview({
      ...draft,
      schedule: { ...draft.schedule!, times: ["bad"] },
    }).days,
  ).toEqual([]);
  expect(buildPlanPreview({ ...draft, mode: "as_needed" }).message).toContain(
    "按需",
  );
});
it("future start and after-open limit do not fabricate tasks", () => {
  const now = localDateTimeToMs("2026-09-02", "09:00");
  expect(
    buildPlanPreview(
      { ...draft, schedule: { ...draft.schedule!, startDate: "2026-09-20" } },
      now,
    ).days,
  ).toEqual([]);
  const result = buildPlanPreview(
    {
      ...draft,
      openedDate: "2026-09-01",
      afterOpenDays: 2,
      schedule: { ...draft.schedule!, endDate: "2026-09-02" },
    },
    now,
  );
  expect(result.days.map((x) => x.date)).toEqual(["2026-09-02"]);
});
