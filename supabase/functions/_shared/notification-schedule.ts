import { load } from "npm:cheerio@1.1.2";

export interface NotificationLesson {
  lesson_key: string;
  lesson_date: string;
  start_time: string;
  end_time: string;
  title: string;
  teacher: string | null;
  room: string | null;
  status: "normal" | "cancelled";
  notes: string | null;
  homework: string | null;
  source_updated_at: string;
}

function field(lines: string[], labels: string[]): string | null {
  for (const line of lines) {
    for (const label of labels) {
      if (line.startsWith(label)) {
        return line.slice(label.length).trim() || null;
      }
    }
  }
  return null;
}

function title(lines: string[]): string {
  const hold = field(lines, ["Hold:"]);
  if (hold && /^\d/.test(hold)) return hold;
  return lines.find((line) =>
    line !== "Aflyst!" && line !== "Ændret!" &&
    !/^\d{1,2}\/\d{1,2}-\d{4}/.test(line) &&
    !/^(Hold|Lærer|Lærere|Lokale|Lokaler|Note|Lektier|Øvrigt indhold):/.test(
      line,
    )
  ) ?? hold ?? "Lektion";
}

export function parseNotificationSchedule(
  html: string,
  expectedStudentId: string,
): NotificationLesson[] {
  if (
    !html.includes("table") ||
    !new RegExp(`elevid=${expectedStudentId}(?:[&'\"]|$)`).test(html)
  ) {
    throw new Error("schedule_identity_mismatch");
  }
  const $ = load(html);
  const table = $("table.s2skema").first();
  if (table.length === 0) throw new Error("schedule_table_missing");
  const days = table.find("td[data-date]");
  if (days.length < 5 || days.length > 8) {
    throw new Error("schedule_day_shape_invalid");
  }

  const now = new Date().toISOString();
  const lessons = new Map<string, NotificationLesson>();
  days.each((_dayIndex, day) => {
    const date = $(day).attr("data-date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("schedule_date_invalid");
    }
    $(day).find("a.s2skemabrik.s2brik").each((_brickIndex, brick) => {
      const key = ($(brick).attr("data-brikid") ?? "").trim();
      if (!key || key.length > 256) return;
      const tooltip = $(brick).attr("data-tooltip") ?? "";
      const lines = tooltip.split(/\r?\n/).map((line) => line.trim()).filter(
        Boolean,
      );
      const times = Array.from(
        tooltip.matchAll(/\b([01]?\d|2[0-3]):[0-5]\d\b/g),
        (match) => match[0],
      );
      if (times.length < 2) return;
      const classes = new Set(($(brick).attr("class") ?? "").split(/\s+/));
      lessons.set(key, {
        lesson_key: key,
        lesson_date: date,
        start_time: times[0],
        end_time: times[times.length - 1],
        title: title(lines).slice(0, 1000),
        teacher: field(lines, ["Lærer:", "Lærere:"]),
        room: field(lines, ["Lokale:", "Lokaler:"]),
        status: classes.has("s2cancelled") ? "cancelled" : "normal",
        notes: null,
        homework: null,
        source_updated_at: now,
      });
    });
  });
  if (lessons.size === 0 || lessons.size > 100) {
    throw new Error("schedule_event_shape_invalid");
  }
  return Array.from(lessons.values());
}

export function isoWeekKey(date = new Date()): string {
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    (((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7,
  );
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
