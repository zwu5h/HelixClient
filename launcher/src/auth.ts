import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export type AccountSummary = {
  id: string;
  username: string;
  uuid: string;
  avatarUrl?: string | null;
  ownsJava: boolean;
  active: boolean;
};

export type AuthStart = {
  authUrl: string;
  state: string;
  redirectUri: string;
  scopes: string;
  clientConfigured: boolean;
  message: string;
};

export type AuthCallbackResult = {
  codeReceived: boolean;
  state: string;
  stateValid: boolean;
  readyForTokenExchange: boolean;
  message: string;
};

export type AuthExchangeResult = {
  account?: AccountSummary | null;
  stage: string;
  success: boolean;
  message: string;
};

export type AuthStatus = "idle" | "loading" | "ready" | "blocked" | "error";

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function loadAccounts(): Promise<AccountSummary[]> {
  try {
    return await invoke<AccountSummary[]>("load_accounts");
  } catch {
    return [];
  }
}

export async function beginMicrosoftLogin(): Promise<AuthStart> {
  try {
    return await invoke<AuthStart>("start_microsoft_login");
  } catch (error) {
    if (isDesktopRuntime()) {
      throw new Error(`Tauri command start_microsoft_login failed: ${String(error)}`);
    }

    const state = createToken();
    const redirectUri = "http://localhost:48189/auth/microsoft/callback";
    const scopes = "XboxLive.signin offline_access";
    return {
      authUrl:
        "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize" +
        `?client_id=configure-HELIX_MICROSOFT_CLIENT_ID&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_mode=query&scope=${encodeURIComponent(scopes)}&state=${state}&code_challenge=preview&code_challenge_method=S256`,
      state,
      redirectUri,
      scopes,
      clientConfigured: false,
      message: "Microsoft OAuth is ready, but HELIX_MICROSOFT_CLIENT_ID is not configured yet."
    };
  }
}

export async function completeMicrosoftCallback(
  callbackUrl: string,
  expectedState?: string
): Promise<AuthCallbackResult> {
  try {
    return await invoke<AuthCallbackResult>("complete_microsoft_callback", { callbackUrl, expectedState });
  } catch (error) {
    if (isDesktopRuntime()) {
      throw new Error(`Tauri command complete_microsoft_callback failed: ${String(error)}`);
    }

    const parsed = new URL(callbackUrl);
    const codeReceived = parsed.searchParams.has("code");
    const state = parsed.searchParams.get("state") ?? "";
    const stateValid = expectedState ? state === expectedState : state.length > 0;

    return {
      codeReceived,
      state,
      stateValid,
      readyForTokenExchange: codeReceived && stateValid,
      message: codeReceived && stateValid
        ? "Callback format and state look valid. Desktop token exchange runs inside Tauri."
        : "Callback could not be accepted. Check the returned state and authorization code."
    };
  }
}

export async function exchangeMicrosoftTokens(): Promise<AuthExchangeResult> {
  try {
    return await invoke<AuthExchangeResult>("exchange_microsoft_tokens");
  } catch (error) {
    return {
      account: null,
      stage: isDesktopRuntime() ? "tauri_command" : "browser_preview",
      success: false,
      message: isDesktopRuntime()
        ? `Tauri command exchange_microsoft_tokens failed: ${String(error)}`
        : "You are using the browser preview. Complete Microsoft login in the Helix desktop window, not http://localhost:1420."
    };
  }
}

export async function logoutAccount(accountId: string): Promise<void> {
  try {
    await invoke("logout_account", { accountId });
  } catch {
    window.localStorage.removeItem(`helix-account-${accountId}`);
  }
}

function createToken(): string {
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
