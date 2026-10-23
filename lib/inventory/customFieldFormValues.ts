/** Only visible form fields may be cleared; disabling a definition must not erase stored data. */
export function customFieldFormValues(
  existing: Record<string, unknown> | null | undefined,
  definitions: readonly { fieldKey: string; fieldType: string }[],
  values: Record<string, string>,
): Record<string, unknown> {
  // Receipts and sync bookkeeping belong to the source record, never a duplicate.
  // The update action restores the current record's internal metadata itself.
  const result = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => !key.startsWith("__bello") && key !== "__restageImport"));
  delete result.belloBrand;
  if (values.belloBrand) result.belloBrand = values.belloBrand;
  for (const definition of definitions) {
    const raw = values[definition.fieldKey];
    delete result[definition.fieldKey];
    if (raw !== undefined && raw !== "") {
      result[definition.fieldKey] = definition.fieldType === "NUMBER" ? Number(raw) : raw;
    }
  }
  return result;
}
