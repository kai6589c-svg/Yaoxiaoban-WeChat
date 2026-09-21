import { expect, it } from "vitest";
import {
  medicationDisplayGroup,
  newBoxPrefill,
} from "../miniprogram/core/medication-copy";
import { medication } from "./fixtures";
it("copies only basic identity fields, never the source box history or photo", () => {
  expect(newBoxPrefill(medication({ storageLocation: "客厅" }))).toEqual({
    profileId: "profile-1",
    name: "测试药",
    specification: "10mg/片",
    unit: "片",
    storageLocation: "客厅",
  });
});
it("display grouping isolates member, unit, specification and incomplete identities", () => {
  const box = medication();
  expect(medicationDisplayGroup(box)).toBe(
    medicationDisplayGroup({ ...box, id: "other", expiryValue: "2028-01-01" }),
  );
  for (const patch of [
    { profileId: "other" },
    { unit: "粒" },
    { specification: "20mg" },
  ])
    expect(medicationDisplayGroup({ ...box, ...patch })).not.toBe(
      medicationDisplayGroup(box),
    );
  expect(medicationDisplayGroup({ ...box, unit: "" })).toBe(box.id);
});
