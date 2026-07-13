/**
 * OS keychain wrapper around @napi-rs/keyring.
 *
 * Lets users store the delegate private key in macOS Keychain / Windows
 * Credential Vault / Linux libsecret instead of a plaintext .env. The
 * bridge accepts `DELEGATE_PRIVATE_KEY` as either:
 *
 *   - `0x[64 hex]`                       — raw key (dev / quickstart)
 *   - `keychain://hpp-x402/<account>`    — opaque URI; resolved at startup
 *
 * The service component of the URI is fixed to `hpp-x402` for now; the
 * account is user-chosen (e.g. `delegate-default`, `delegate-mainnet`).
 * Keeping the service constant means a single namespace appears in the
 * OS Keychain UI, and the CLI commands stay short.
 *
 * Security notes:
 *   - The plaintext key still exists in process memory after `getPassword`.
 *     Defense-in-depth means rotating the delegate quickly is cheap (it
 *     only holds today's allowance, not the Safe balance).
 *   - We never log the resolved key. Errors surface only the URI.
 */
import { Entry } from "@napi-rs/keyring";

const KEYCHAIN_PREFIX = "keychain://";
const SERVICE = "hpp-x402";
const HEX_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/;

export type KeychainURI = `keychain://${string}`;

export function isKeychainURI(value: string): value is KeychainURI {
  return value.startsWith(KEYCHAIN_PREFIX);
}

export function isHexKey(value: string): value is `0x${string}` {
  return HEX_KEY_RE.test(value);
}

/**
 * Parse a `keychain://hpp-x402/<account>` URI into its account name.
 * Throws on a malformed URI so the bridge fails loudly at startup
 * instead of silently looking up the wrong slot.
 */
export function parseKeychainURI(uri: string): { service: string; account: string } {
  if (!isKeychainURI(uri)) {
    throw new Error(`not a keychain URI: ${uri}`);
  }
  const rest = uri.slice(KEYCHAIN_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    throw new Error(
      `keychain URI missing account: ${uri} (expected keychain://${SERVICE}/<account>)`,
    );
  }
  const service = rest.slice(0, slash);
  const account = rest.slice(slash + 1);
  if (service !== SERVICE) {
    throw new Error(
      `keychain URI service must be "${SERVICE}", got "${service}"`,
    );
  }
  if (!ACCOUNT_RE.test(account)) {
    throw new Error(
      `keychain URI account "${account}" must match ${ACCOUNT_RE} (no spaces, slashes, etc.)`,
    );
  }
  return { service, account };
}

export function buildKeychainURI(account: string): KeychainURI {
  if (!ACCOUNT_RE.test(account)) {
    throw new Error(`invalid account name "${account}" — must match ${ACCOUNT_RE}`);
  }
  return `keychain://${SERVICE}/${account}` as KeychainURI;
}

/**
 * Resolve a keychain URI to the stored hex private key. Throws if the
 * keychain entry is missing or holds a value that doesn't look like a
 * key (catches "I stored garbage in this slot" mistakes early).
 */
export function resolveKeychain(uri: string): `0x${string}` {
  const { service, account } = parseKeychainURI(uri);
  const entry = new Entry(service, account);
  let secret: string | null;
  try {
    secret = entry.getPassword();
  } catch (err) {
    throw new Error(
      `keychain read failed for ${uri}: ${(err as Error).message}\n` +
        `Set it first with: hpp-x402-keychain set ${account}`,
    );
  }
  if (!secret) {
    throw new Error(
      `keychain entry not found: ${uri}\n` +
        `Set it first with: hpp-x402-keychain set ${account}`,
    );
  }
  if (!isHexKey(secret)) {
    throw new Error(
      `keychain entry ${uri} does not contain a 0x + 64-hex private key`,
    );
  }
  return secret;
}

export function setKeychain(account: string, hexKey: `0x${string}`): void {
  if (!isHexKey(hexKey)) {
    throw new Error("expected 0x + 64 hex chars");
  }
  if (!ACCOUNT_RE.test(account)) {
    throw new Error(`invalid account name "${account}"`);
  }
  const entry = new Entry(SERVICE, account);
  entry.setPassword(hexKey);
}

export function deleteKeychain(account: string): boolean {
  const entry = new Entry(SERVICE, account);
  try {
    return entry.deletePassword();
  } catch {
    return false;
  }
}

export function getKeychainURIPattern(): string {
  return `keychain://${SERVICE}/<account>`;
}

export const KEYCHAIN_SERVICE = SERVICE;
