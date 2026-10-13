import { createClient } from "npm:@supabase/supabase-js@2.49.8";
import {
  cookieJarPayload,
  encryptLectioSession,
} from "../_shared/lectio-session-crypto.ts";
import {
  currentKeyVersion,
  masterKeyForVersion,
} from "../_shared/lectio-session-capture.ts";

interface RegistrationBody {
  studentId?: string;
  schoolId?: number;
  autologinToken?: string;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await req.json().catch(() => null) as RegistrationBody | null;
  const studentId = body?.studentId?.trim() ?? "";
  const schoolId = body?.schoolId;
  const token = body?.autologinToken?.trim() ?? "";
  if (
    !/^\d+$/.test(studentId) || !Number.isSafeInteger(schoolId) ||
    (schoolId ?? 0) <= 0
  ) {
    return json({ error: "Invalid identity" }, 400);
  }
  if (token.length < 8 || token.length > 4096) {
    return json({ error: "Invalid token" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(url, serviceKey);
  const { data: student, error: studentError } = await admin
    .from("students")
    .select("id,school_id")
    .eq("id", studentId)
    .eq("school_id", schoolId!)
    .eq("supabase_id", userData.user.id)
    .maybeSingle();
  if (studentError || !student) {
    return json({ error: "Identity mismatch" }, 403);
  }

  const keyVersion = currentKeyVersion();
  const encrypted = await encryptLectioSession(
    cookieJarPayload(
      new Map([["autologinkeyV2", token]]),
      studentId,
      String(schoolId),
    ),
    masterKeyForVersion(keyVersion),
    keyVersion,
  );
  const { error } = await admin.from("lectio_tokens").upsert({
    student_id: studentId,
    school_id: schoolId,
    encrypted_token: null,
    key_version: encrypted.keyVersion,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    wrapped_dek: encrypted.wrappedDek,
    wrap_iv: encrypted.wrapIv,
    next_poll_at: new Date().toISOString(),
    claimed_until: null,
    claim_token: null,
    consecutive_failures: 0,
    disabled_at: null,
    last_error_code: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "student_id" });
  if (error) {
    console.error("Notification credential registration failed", {
      message: error.message,
    });
    return json({ error: "Registration failed" }, 500);
  }
  return json({ ok: true });
});
