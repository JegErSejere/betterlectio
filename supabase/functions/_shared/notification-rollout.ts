export function parseNotificationStudentScope(
  value: string | undefined,
): string[] | null {
  const normalized = value?.trim() ?? "";
  if (normalized === "*") return null;
  if (!normalized) return [];

  const ids = Array.from(
    new Set(normalized.split(",").map((id) => id.trim()).filter(Boolean)),
  );
  if (ids.length > 100 || ids.some((id) => !/^\d+$/.test(id))) {
    throw new Error("SCHEDULE_NOTIFICATION_STUDENT_IDS is invalid");
  }
  return ids;
}
