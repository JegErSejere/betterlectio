import { createClient } from "npm:@supabase/supabase-js@2.49.8";
import {
  fetchWithJar,
  isLectioLoginHtml,
  SessionExpiredError,
} from "../_shared/lectio-http.ts";
import {
  cookieJarPayload,
  decryptLectioSession,
  encryptLectioSession,
  payloadToJar,
} from "../_shared/lectio-session-crypto.ts";
import {
  currentKeyVersion,
  masterKeyForVersion,
} from "../_shared/lectio-session-capture.ts";
import {
  isoWeekKey,
  parseNotificationSchedule,
} from "../_shared/notification-schedule.ts";
import { parseNotificationStudentScope } from "../_shared/notification-rollout.ts";

interface PollClaim {
  student_id: string;
  school_id: number;
  key_version: number;
  ciphertext: string;
  iv: string;
  wrapped_dek: string;
  wrap_iv: string;
  claim_token: string;
}

type AdminClient = ReturnType<typeof createClient<any>>;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fail(
  admin: AdminClient,
  claim: PollClaim,
  code: string,
  terminal: boolean,
): Promise<void> {
  const { error } = await admin.rpc("fail_notification_poll", {
    p_student_id: claim.student_id,
    p_claim_token: claim.claim_token,
    p_error_code: code,
    p_terminal: terminal,
  });
  if (error) {
    console.error("Could not record notification poll failure", {
      message: error.message,
    });
  }
}

async function poll(
  admin: AdminClient,
  claim: PollClaim,
): Promise<boolean> {
  try {
    const schoolId = String(claim.school_id);
    const payload = await decryptLectioSession(
      {
        keyVersion: claim.key_version,
        ciphertext: claim.ciphertext,
        iv: claim.iv,
        wrappedDek: claim.wrapped_dek,
        wrapIv: claim.wrap_iv,
      },
      masterKeyForVersion(claim.key_version),
      claim.student_id,
      schoolId,
    );
    const jar = payloadToJar(payload);
    const weekKey = isoWeekKey();
    const [year, week] = weekKey.split("-W");
    const url =
      `https://www.lectio.dk/lectio/${schoolId}/SkemaNy.aspx?elevid=${claim.student_id}&week=${week}${year}`;
    const fetched = await fetchWithJar(url, jar);
    const html = new TextDecoder().decode(fetched.body);
    if (!fetched.response.ok) {
      throw new Error(`lectio_http_${fetched.response.status}`);
    }
    if (isLectioLoginHtml(html)) throw new SessionExpiredError();
    const lessons = parseNotificationSchedule(html, claim.student_id);

    const { error: syncError } = await admin.rpc("sync_student_week", {
      p_student_id: claim.student_id,
      p_week_key: weekKey,
      p_lessons: lessons,
    });
    if (syncError) throw new Error(`schedule_sync_failed:${syncError.message}`);

    const keys = lessons.map((lesson) => lesson.lesson_key);
    const { error: freshnessError } = await admin.from("lessons").update({
      presence_state: "present",
      last_verified_at: new Date().toISOString(),
    }).eq("school_id", claim.school_id).in("lesson_key", keys);
    if (freshnessError) {
      throw new Error(`freshness_update_failed:${freshnessError.message}`);
    }

    const keyVersion = currentKeyVersion();
    const encrypted = await encryptLectioSession(
      cookieJarPayload(jar, claim.student_id, schoolId),
      masterKeyForVersion(keyVersion),
      keyVersion,
    );
    const { data, error } = await admin.rpc("complete_notification_poll", {
      p_student_id: claim.student_id,
      p_claim_token: claim.claim_token,
      p_key_version: encrypted.keyVersion,
      p_ciphertext: encrypted.ciphertext,
      p_iv: encrypted.iv,
      p_wrapped_dek: encrypted.wrappedDek,
      p_wrap_iv: encrypted.wrapIv,
    });
    if (error || !data) throw new Error("poll_claim_lost");
    return true;
  } catch (error) {
    const terminal = error instanceof SessionExpiredError ||
      (error instanceof DOMException && error.name === "OperationError");
    const code = terminal
      ? error instanceof SessionExpiredError
        ? "session_expired"
        : "decrypt_failed"
      : error instanceof Error
      ? error.message.slice(0, 100)
      : "poll_failed";
    await fail(admin, claim, code, terminal);
    console.warn("Notification schedule poll failed", {
      studentId: claim.student_id,
      code,
      terminal,
    });
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const expected = Deno.env.get("NOTIFICATION_CRON_SECRET") ??
    Deno.env.get("LECTIO_KEEPALIVE_CRON_SECRET");
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (Deno.env.get("SCHEDULE_NOTIFICATIONS_ENABLED") !== "true") {
    return json({ ok: true, disabled: true, claimed: 0 });
  }
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  const studentScope = parseNotificationStudentScope(
    Deno.env.get("SCHEDULE_NOTIFICATION_STUDENT_IDS"),
  );
  const { data, error } = await admin.rpc("claim_due_notification_polls", {
    p_batch_size: 10,
    p_lease_seconds: 180,
    p_student_ids: studentScope,
  });
  if (error) {
    console.error("Could not claim notification polls", {
      message: error.message,
    });
    return json({ error: "Claim failed" }, 500);
  }
  let succeeded = 0;
  for (const claim of (data ?? []) as PollClaim[]) {
    if (await poll(admin, claim)) succeeded++;
  }
  return json({
    ok: true,
    scope: studentScope === null ? "all" : "canary",
    configured: studentScope?.length ?? null,
    claimed: data?.length ?? 0,
    succeeded,
  });
});
