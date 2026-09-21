import type { Medication } from "./models";
/** An explicit allowlist: a new box must never inherit plans, photos or stock. */
export const newBoxPrefill = (source: Medication) => ({
  profileId: source.profileId,
  name: source.name,
  specification: source.specification,
  unit: source.unit,
  storageLocation: source.storageLocation ?? "",
});
/** Display grouping does not imply interchangeability or shared stock. */
export const medicationDisplayGroup = (medication: Medication): string =>
  medication.name.trim() &&
  medication.specification.trim() &&
  medication.unit.trim()
    ? JSON.stringify([
        medication.profileId,
        medication.name.trim(),
        medication.specification.trim(),
        medication.unit.trim(),
      ])
    : medication.id;
