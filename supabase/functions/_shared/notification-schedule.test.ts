import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  isoWeekKey,
  parseNotificationSchedule,
} from "./notification-schedule.ts";

const html = `
<table class="s2skema"><tr>
  <td data-date="2026-10-12"><a class="s2skemabrik s2brik s2normal" data-brikid="ABS1"
    data-tooltip="Matematik\n12/10-2026 08:10 til 09:50\nHold: 2x MA\nLærer: AB\nLokale: 12"
    href="/lectio/94/aktivitet.aspx?elevid=123&amp;absid=1"></a></td>
  <td data-date="2026-10-13"><a class="s2skemabrik s2brik s2cancelled" data-brikid="ABS2"
    data-tooltip="Aflyst!\nFysik\n13/10-2026 10:05 til 11:45\nHold: 2x FY"
    href="/lectio/94/aktivitet.aspx?elevid=123&amp;absid=2"></a></td>
  <td data-date="2026-10-14"></td><td data-date="2026-10-15"></td><td data-date="2026-10-16"></td>
</tr></table>`;

Deno.test("notification schedule parser extracts explicit cancellation", () => {
  const lessons = parseNotificationSchedule(html, "123");
  assertEquals(lessons.length, 2);
  assertEquals(lessons[0].title, "2x MA");
  assertEquals(lessons[0].teacher, "AB");
  assertEquals(lessons[1].status, "cancelled");
});

Deno.test("notification schedule parser fails closed on identity mismatch", () => {
  assertThrows(
    () => parseNotificationSchedule(html, "999"),
    Error,
    "schedule_identity_mismatch",
  );
});

Deno.test("ISO week key handles year boundary", () => {
  assertEquals(isoWeekKey(new Date("2027-01-01T12:00:00Z")), "2026-W53");
});
