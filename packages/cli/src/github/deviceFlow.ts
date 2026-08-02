export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds to wait between polls (GitHub's own `interval`, honored — and bumped — by `pollForToken` below on `slow_down`). */
  interval: number;
  /** Seconds until `deviceCode` expires. */
  expiresIn: number;
}

export interface RequestDeviceCodeOptions {
  clientId: string;
  /** Space-separated OAuth scopes; defaults to `"repo"`. GitHub's `repo` scope covers check-run reads. */
  scope?: string;
  fetchImpl?: typeof fetch;
}

export class DeviceFlowError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "request-failed"
      | "expired_token"
      | "access_denied"
      | "timeout"
      | "unknown",
  ) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

interface RawDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function requestDeviceCode(
  options: RequestDeviceCodeOptions,
): Promise<DeviceCodeResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: options.clientId, scope: options.scope ?? "repo" }),
  });

  if (!response.ok) {
    throw new DeviceFlowError(
      `GitHub device code request failed: HTTP ${response.status}`,
      "request-failed",
    );
  }

  const data = (await response.json()) as RawDeviceCodeResponse;
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: data.interval,
    expiresIn: data.expires_in,
  };
}

export interface PollForTokenOptions {
  clientId: string;
  deviceCode: string;
  /** Starting poll interval in seconds — bumped by +5s on `slow_down` per GitHub's own protocol. */
  interval: number;
  fetchImpl?: typeof fetch;
  /** Test seam; defaults to a real `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Caps poll attempts — defaults to a generous bound well past any real device code's expiry. */
  maxAttempts?: number;
}

export interface PollForTokenResult {
  accessToken: string;
  /** GitHub's granted-scope string for the token, e.g. `"repo"`. */
  scope: string;
}

interface RawTokenResponse {
  access_token?: string;
  scope?: string;
  error?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function pollForToken(options: PollForTokenOptions): Promise<PollForTokenResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 900;
  let interval = options.interval;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(interval * 1000);

    const response = await fetchImpl(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: options.clientId,
        device_code: options.deviceCode,
        grant_type: GRANT_TYPE,
      }),
    });

    const data = (await response.json()) as RawTokenResponse;

    if (data.access_token) {
      return { accessToken: data.access_token, scope: data.scope ?? "" };
    }

    switch (data.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "expired_token":
        throw new DeviceFlowError("device code expired before it was approved", "expired_token");
      case "access_denied":
        throw new DeviceFlowError("GitHub sign-in was denied", "access_denied");
      default:
        throw new DeviceFlowError(
          `unexpected GitHub device flow response: ${data.error ?? "(no error field)"}`,
          "unknown",
        );
    }
  }

  throw new DeviceFlowError("device flow polling exceeded its maximum attempts", "timeout");
}
