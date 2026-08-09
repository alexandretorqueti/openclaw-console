import assert from "node:assert/strict";
import test from "node:test";
import { buildDeviceAuthPayloadV3, encodeGatewayRequest, GatewayProtocolError, parseGatewayFrame } from "./index.js";

test("encodes a protocol v4 request frame without inventing fields", () => {
  assert.deepEqual(JSON.parse(encodeGatewayRequest("request-1", "agents.list", {})), {
    type: "req",
    id: "request-1",
    method: "agents.list",
    params: {},
  });
});

test("parses response and event envelopes defensively", () => {
  assert.deepEqual(
    parseGatewayFrame('{"type":"res","id":"1","ok":false,"error":{"code":"NOPE","message":"denied"}}'),
    { type: "res", id: "1", ok: false, error: { code: "NOPE", message: "denied" } },
  );
  assert.deepEqual(parseGatewayFrame('{"type":"event","event":"chat","payload":{"state":"delta"},"seq":7}'), {
    type: "event",
    event: "chat",
    payload: { state: "delta" },
    seq: 7,
  });
});

test("builds the documented v3 device signature payload byte-for-byte", () => {
  assert.equal(buildDeviceAuthPayloadV3({ deviceId: "dev", clientId: "gateway-client", clientMode: "backend", role: "operator", scopes: ["operator.read", "operator.write"], signedAtMs: 123, token: "shared", nonce: "challenge", platform: "Node" }), "v3|dev|gateway-client|backend|operator|operator.read,operator.write|123|shared|challenge|node|");
});

test("rejects malformed JSON and malformed envelopes", () => {
  assert.throws(() => parseGatewayFrame("{"), GatewayProtocolError);
  assert.throws(() => parseGatewayFrame('{"type":"res","ok":true}'), GatewayProtocolError);
});
