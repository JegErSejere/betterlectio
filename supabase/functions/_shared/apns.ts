interface ApnsConfiguration {
  keyId: string;
  teamId: string;
  privateKey: string;
  bundleId: string;
}

let cachedToken: { value: string; createdAt: number } | null = null;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function textBase64Url(value: string): string {
  return base64Url(new TextEncoder().encode(value));
}

function pemBytes(value: string): Uint8Array {
  const normalized = value.replace(/\\n/g, "\n");
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function apnsConfiguration(): ApnsConfiguration {
  const config = {
    keyId: Deno.env.get("APNS_KEY_ID") ?? "",
    teamId: Deno.env.get("APNS_TEAM_ID") ?? "",
    privateKey: Deno.env.get("APNS_PRIVATE_KEY") ??
      Deno.env.get("APNS_KEY_P8") ?? "",
    bundleId: Deno.env.get("APNS_BUNDLE_ID") ?? "dk.echolabs.betterlectio.app",
  };
  if (
    !config.keyId || !config.teamId || !config.privateKey || !config.bundleId
  ) {
    throw new Error("APNs configuration is incomplete");
  }
  return config;
}

export async function apnsAuthorization(
  config: ApnsConfiguration,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now - cachedToken.createdAt < 50 * 60) {
    return cachedToken.value;
  }
  const header = textBase64Url(
    JSON.stringify({ alg: "ES256", kid: config.keyId }),
  );
  const claims = textBase64Url(
    JSON.stringify({ iss: config.teamId, iat: now }),
  );
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(pemBytes(config.privateKey)).buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const value = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  cachedToken = { value, createdAt: now };
  return value;
}
