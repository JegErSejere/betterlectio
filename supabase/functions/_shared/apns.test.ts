import { assert, assertEquals } from "jsr:@std/assert@1";
import { apnsAuthorization } from "./apns.ts";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

Deno.test("APNs authorization produces a verifiable ES256 provider token", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", keys.privateKey),
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    base64(pkcs8)
  }\n-----END PRIVATE KEY-----`;

  const token = await apnsAuthorization({
    keyId: "TESTKEY123",
    teamId: "TESTTEAM12",
    privateKey: pem,
    bundleId: "dk.echolabs.betterlectio.app",
  });
  const [headerPart, claimsPart, signaturePart] = token.split(".");
  assert(headerPart && claimsPart && signaturePart);
  assertEquals(
    JSON.parse(new TextDecoder().decode(base64UrlBytes(headerPart))),
    { alg: "ES256", kid: "TESTKEY123" },
  );
  const claims = JSON.parse(
    new TextDecoder().decode(base64UrlBytes(claimsPart)),
  );
  assertEquals(claims.iss, "TESTTEAM12");
  assert(Number.isInteger(claims.iat));

  const signature = base64UrlBytes(signaturePart);
  assertEquals(signature.byteLength, 64);
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.publicKey,
      signature,
      new TextEncoder().encode(`${headerPart}.${claimsPart}`),
    ),
  );
});
