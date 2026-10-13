import { createClient } from "npm:@supabase/supabase-js@2.49.8";
import { apnsAuthorization, apnsConfiguration } from "../_shared/apns.ts";
import { parseNotificationStudentScope } from "../_shared/notification-rollout.ts";

interface DeliveryClaim {
  outbox_id: string;
  student_id: string;
  payload: Record<string, unknown>;
  claim_token: string;
}

interface DeviceToken {
  apns_token: string;
  environment: "sandbox" | "production";
}

type AdminClient = ReturnType<typeof createClient<any>>;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function finish(
  admin: AdminClient,
  claim: DeliveryClaim,
  success: boolean,
  terminal = false,
): Promise<void> {
  const name = success
    ? "complete_notification_delivery"
    : "fail_notification_delivery";
  const params = success
    ? { p_outbox_id: claim.outbox_id, p_claim_token: claim.claim_token }
    : {
      p_outbox_id: claim.outbox_id,
      p_claim_token: claim.claim_token,
      p_terminal: terminal,
    };
  const { error } = await admin.rpc(name, params);
  if (error) {
    console.error("Could not finish notification delivery", {
      id: claim.outbox_id,
      message: error.message,
    });
  }
}

async function deliver(
  admin: AdminClient,
  claim: DeliveryClaim,
): Promise<boolean> {
  const { data, error } = await admin.from("device_tokens")
    .select("apns_token,environment")
    .eq("student_id", claim.student_id);
  if (error) {
    await finish(admin, claim, false);
    return false;
  }
  const devices = (data ?? []) as DeviceToken[];
  if (devices.length === 0) {
    await finish(admin, claim, true);
    return true;
  }

  const config = apnsConfiguration();
  const authorization = await apnsAuthorization(config);
  const title = typeof claim.payload.title === "string"
    ? claim.payload.title
    : "Skemaændring";
  const body = typeof claim.payload.body === "string"
    ? claim.payload.body
    : "Dit skema er blevet ændret.";
  const apnsBody = JSON.stringify({
    aps: {
      alert: { title, body },
      sound: "default",
      "thread-id": "schedule-changes",
    },
    lesson_key: claim.payload.lesson_key,
    lesson_date: claim.payload.lesson_date,
  });
  let delivered = false;
  let transientFailure = false;
  let terminalFailure = false;
  const expiration = String(Math.floor(Date.now() / 1000) + 24 * 60 * 60);
  for (const device of devices) {
    const host = device.environment === "sandbox"
      ? "api.sandbox.push.apple.com"
      : "api.push.apple.com";
    try {
      const response = await fetch(
        `https://${host}/3/device/${device.apns_token}`,
        {
          method: "POST",
          headers: {
            authorization: `bearer ${authorization}`,
            "apns-topic": config.bundleId,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-expiration": expiration,
            "apns-collapse-id": claim.outbox_id,
          },
          body: apnsBody,
        },
      );
      if (response.ok) {
        delivered = true;
        continue;
      }
      const reason = await response.json().catch(() => ({})) as {
        reason?: string;
      };
      if (
        response.status === 410 || reason.reason === "BadDeviceToken" ||
        reason.reason === "Unregistered"
      ) {
        await admin.from("device_tokens").delete().eq(
          "apns_token",
          device.apns_token,
        );
      } else if (
        response.status >= 500 || response.status === 429 ||
        response.status === 403
      ) {
        transientFailure = true;
      } else {
        terminalFailure = true;
      }
      console.warn("APNs rejected notification", {
        status: response.status,
        reason: reason.reason,
      });
    } catch (error) {
      transientFailure = true;
      console.warn("APNs request failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  if (delivered || (!transientFailure && !terminalFailure)) {
    await finish(admin, claim, true);
    return true;
  }
  await finish(admin, claim, false, terminalFailure && !transientFailure);
  return false;
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
  const { data, error } = await admin.rpc("claim_due_notification_deliveries", {
    p_batch_size: 50,
    p_lease_seconds: 180,
    p_student_ids: studentScope,
  });
  if (error) {
    console.error("Could not claim notification deliveries", {
      message: error.message,
    });
    return json({ error: "Claim failed" }, 500);
  }
  let succeeded = 0;
  for (const claim of (data ?? []) as DeliveryClaim[]) {
    if (await deliver(admin, claim)) succeeded++;
  }
  return json({
    ok: true,
    scope: studentScope === null ? "all" : "canary",
    configured: studentScope?.length ?? null,
    claimed: data?.length ?? 0,
    succeeded,
  });
});
