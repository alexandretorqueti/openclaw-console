import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GatewayDeviceIdentity } from "@alexandretorqueti/openclaw-gateway-client";

type StoredIdentity = GatewayDeviceIdentity & { version: 1; createdAtMs: number };
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }) as Buffer;
  if (der.length !== SPKI_PREFIX.length + 32 || !der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) throw new Error("Unsupported Ed25519 public key");
  return der.subarray(SPKI_PREFIX.length);
}
function normalize(stored: unknown): StoredIdentity | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const value = stored as Partial<StoredIdentity>;
  if (value.version !== 1 || typeof value.deviceId !== "string" || typeof value.publicKey !== "string" || typeof value.privateKeyPem !== "string") return undefined;
  const deviceId = createHash("sha256").update(Buffer.from(value.publicKey, "base64url")).digest("hex");
  if (deviceId !== value.deviceId) throw new Error("Stored device identity fingerprint mismatch");
  return { version: 1, deviceId, publicKey: value.publicKey, privateKeyPem: value.privateKeyPem, createdAtMs: typeof value.createdAtMs === "number" ? value.createdAtMs : Date.now() };
}

export function loadOrCreateDeviceIdentity(path: string): GatewayDeviceIdentity {
  try {
    const stored = normalize(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (stored) return stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicKeyRaw = rawPublicKey(publicKeyPem);
  const stored: StoredIdentity = {
    version: 1,
    deviceId: createHash("sha256").update(publicKeyRaw).digest("hex"),
    publicKey: publicKeyRaw.toString("base64url"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    createdAtMs: Date.now(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return stored;
}
