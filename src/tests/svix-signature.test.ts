import { describe, expect, it } from "vitest";

import { verifySvixSignature } from "@/workflows/svixSignature";

/**
 * Svix's own published test vector (docs.svix.com/receiving/verifying-payloads/how-manual):
 * secret whsec_plJ3nmyCDGBKInavdOK15jsl, id msg_loFOjxBNrRLzqYUf, timestamp
 * 1731705121, body {"event_type":"ping","data":{"success":true}} ->
 * v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=. Confirmed independently
 * against Node's crypto.createHmac before writing verifySvixSignature() -
 * this is the real algorithm, not a guess.
 */
const VECTOR = {
  secret: "whsec_plJ3nmyCDGBKInavdOK15jsl",
  svixId: "msg_loFOjxBNrRLzqYUf",
  svixTimestamp: "1731705121",
  rawBody: `{"event_type":"ping","data":{"success":true}}`,
  svixSignature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
};

/** The vector's timestamp is fixed in the past - freeze the clock next to it so the tolerance check doesn't reject it as stale. */
const FROZEN_NOW = () => 1731705121 * 1000;

describe("verifySvixSignature", () => {
  it("accepts Svix's own published test vector", async () => {
    const result = await verifySvixSignature({ ...VECTOR, now: FROZEN_NOW });
    expect(result).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const result = await verifySvixSignature({
      ...VECTOR,
      rawBody: `{"event_type":"ping","data":{"success":false}}`,
      now: FROZEN_NOW,
    });
    expect(result).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    const result = await verifySvixSignature({
      ...VECTOR,
      secret: "whsec_wrongSecretEntirelyXXXXXXXX",
      now: FROZEN_NOW,
    });
    expect(result).toBe(false);
  });

  it("rejects a mismatched svix-id (part of the signed content)", async () => {
    const result = await verifySvixSignature({
      ...VECTOR,
      svixId: "msg_someOtherIdEntirely",
      now: FROZEN_NOW,
    });
    expect(result).toBe(false);
  });

  it("rejects a signature with no matching version/value pair", async () => {
    const result = await verifySvixSignature({
      ...VECTOR,
      svixSignature: "v1,thisIsNotTheRightSignatureAtAll=",
      now: FROZEN_NOW,
    });
    expect(result).toBe(false);
  });

  it("matches one of several space-separated candidates (secret rotation)", async () => {
    const result = await verifySvixSignature({
      ...VECTOR,
      svixSignature: `v1,wrongOne= ${VECTOR.svixSignature} v1,anotherWrongOne=`,
      now: FROZEN_NOW,
    });
    expect(result).toBe(true);
  });

  it("ignores an unrecognized signature version", async () => {
    const result = await verifySvixSignature({
      ...VECTOR,
      svixSignature: VECTOR.svixSignature.replace("v1,", "v2,"),
      now: FROZEN_NOW,
    });
    expect(result).toBe(false);
  });

  it("rejects a non-numeric timestamp", async () => {
    const result = await verifySvixSignature({
      ...VECTOR,
      svixTimestamp: "not-a-number",
      now: FROZEN_NOW,
    });
    expect(result).toBe(false);
  });

  it("rejects a timestamp far outside the replay tolerance", async () => {
    const result = await verifySvixSignature({
      ...VECTOR,
      now: () => FROZEN_NOW() + 60 * 60 * 1000, // one hour later
    });
    expect(result).toBe(false);
  });

  it("accepts a timestamp just inside the tolerance window", async () => {
    const result = await verifySvixSignature({
      ...VECTOR,
      now: () => FROZEN_NOW() + 4 * 60 * 1000, // 4 minutes later, under the 5-minute tolerance
    });
    expect(result).toBe(true);
  });
});
