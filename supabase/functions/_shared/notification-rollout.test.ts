import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parseNotificationStudentScope } from "./notification-rollout.ts";

Deno.test("notification rollout defaults to nobody", () => {
  assertEquals(parseNotificationStudentScope(undefined), []);
  assertEquals(parseNotificationStudentScope("  "), []);
});

Deno.test("notification rollout parses and deduplicates canary students", () => {
  assertEquals(parseNotificationStudentScope("123, 456,123"), ["123", "456"]);
});

Deno.test("notification rollout requires an explicit wildcard for everyone", () => {
  assertEquals(parseNotificationStudentScope("*"), null);
  assertThrows(() => parseNotificationStudentScope("123,*"));
  assertThrows(() => parseNotificationStudentScope("student-123"));
});
