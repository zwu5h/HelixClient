# Helix Client Auth Storage Plan

Phase 2 defines the account boundary. Phase 3 will implement the full Microsoft, Xbox Live, XSTS and Minecraft Services flow.

## Rules

- Never ask for or store Microsoft passwords.
- Use browser-based Microsoft OAuth only.
- Treat Microsoft, Xbox, XSTS and Minecraft tokens as secrets.
- Store only non-sensitive account summaries in normal launcher config.
- Validate Minecraft Java ownership before launch.
- Support logout and account switching.

## Storage Strategy

Use the operating system credential store through a Tauri-compatible secure storage layer.

Recommended shape:

- Account summaries: username, UUID, skin/avatar URL, Java ownership status and active flag.
- Secret token record: Microsoft refresh token, Minecraft access token, expiry timestamps and refresh metadata.
- Secret lookup key: stable local account id, not the Minecraft UUID alone.

On Windows, this should map to Windows Credential Manager through the selected secure storage crate/plugin. Tokens must not be written to `launcher-config.json`, logs, crash reports or exported settings.

## Phase 3 Auth Flow

1. Open Microsoft OAuth in the browser with PKCE and a random state.
2. Receive the authorization code through a localhost callback or custom protocol.
3. Exchange the code for Microsoft tokens.
4. Authenticate with Xbox Live.
5. Authenticate with XSTS.
6. Authenticate with Minecraft Services.
7. Fetch the Minecraft profile.
8. Check Java ownership.
9. Save account summary and secret token record separately.

## Microsoft App Registration

Helix needs a Microsoft Entra app registration before production sign-in can work.

Required local environment values:

- `HELIX_MICROSOFT_CLIENT_ID`: public client/application id from the app registration.
- `HELIX_MICROSOFT_REDIRECT_URI`: optional override. Defaults to `http://localhost:48189/auth/microsoft/callback`.
- `HELIX_MICROSOFT_CLIENT_SECRET`: optional fallback only for a confidential Web app registration. Prefer not using this for the launcher.

Registered redirect URI must exactly match the value used by the launcher.

Preferred Azure configuration:

- Platform: Mobile and desktop applications, or another public-client/native configuration that permits auth-code with PKCE.
- Redirect URI: `http://localhost:48189/auth/microsoft/callback`.
- Public client flow: enabled if the portal exposes that option.
- No client secret required.

If the app was created as a Web app/confidential client, Microsoft may return HTTP 401 or an `invalid_client`/secret-related token error. Either reconfigure it as a public client/native app, or set `HELIX_MICROSOFT_CLIENT_SECRET` locally as a temporary workaround.

Required OAuth request details:

- Tenant: `consumers`
- Flow: authorization code with PKCE
- Response type: `code`
- Response mode: `query`
- Scopes: `XboxLive.signin offline_access`
- PKCE method: `S256`
- Prompt: `select_account`

Current implementation status:

- PKCE verifier/challenge generation exists in the Rust backend.
- Random state generation and callback state validation exist in the Rust backend.
- Authorization codes are not returned to the UI and must not be logged.
- Microsoft token exchange exists in the Rust backend.
- Xbox Live authentication and XSTS authorization exist in the Rust backend.
- Minecraft Services login, profile fetch and ownership validation exist in the Rust backend.
- Tokens are held in memory during the flow only. Secure persistent storage is still pending.

## Token Exchange Targets

After accepting a callback, Phase 3 runs these service calls:

- Microsoft token endpoint: exchange authorization code with the PKCE verifier.
- Xbox Live user authentication.
- XSTS authorization.
- Minecraft Services login with the XSTS token.
- Minecraft profile fetch.
- Minecraft Java ownership validation.

The UI must only receive:

- Auth stage.
- Success/failure state.
- Safe account summary: username, UUID, Java ownership and active flag.

The UI must never receive Microsoft access tokens, Microsoft refresh tokens, Xbox Live tokens, XSTS tokens, Minecraft access tokens or authorization codes.

## Logout Behavior

Logout should remove the secret token record and mark the account inactive. A full account removal should also remove the account summary.

## Logging

Auth logs may include phase names, response status categories and expiry timestamps. They must never include access tokens, refresh tokens, authorization codes or full OAuth callback URLs.
