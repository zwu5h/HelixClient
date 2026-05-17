use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::Mutex,
    thread,
};
use tauri::{Emitter, Manager};

const MICROSOFT_AUTHORITY: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const DEFAULT_REDIRECT_URI: &str = "http://localhost:48189/auth/microsoft/callback";
const MINECRAFT_SCOPES: &str = "XboxLive.signin offline_access";

#[derive(Default)]
struct AuthRuntime {
    pending: Mutex<Option<PendingMicrosoftAuth>>,
    accounts: Mutex<Vec<AccountSummary>>,
    callback_listener_started: Mutex<bool>,
}

#[derive(Debug, Clone)]
struct PendingMicrosoftAuth {
    state: String,
    code_verifier: String,
    redirect_uri: String,
    authorization_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherConfig {
    selected_profile_id: String,
    selected_version_id: String,
    selected_modpack_id: String,
    accent_color: String,
    background_animation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountSummary {
    id: String,
    username: String,
    uuid: String,
    avatar_url: Option<String>,
    owns_java: bool,
    active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStart {
    auth_url: String,
    state: String,
    redirect_uri: String,
    scopes: String,
    client_configured: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthCallbackResult {
    code_received: bool,
    state: String,
    state_valid: bool,
    ready_for_token_exchange: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthExchangeResult {
    account: Option<AccountSummary>,
    stage: String,
    success: bool,
    message: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MicrosoftTokenResponse {
    access_token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct XboxAuthResponse {
    token: String,
    display_claims: XboxDisplayClaims,
}

#[derive(Debug, Clone, Deserialize)]
struct XboxDisplayClaims {
    xui: Vec<XboxUserClaim>,
}

#[derive(Debug, Clone, Deserialize)]
struct XboxUserClaim {
    uhs: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftAuthResponse {
    access_token: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftProfileResponse {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftEntitlementsResponse {
    items: Vec<MinecraftEntitlement>,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftEntitlement {
    name: String,
}

impl Default for LauncherConfig {
    fn default() -> Self {
        Self {
            selected_profile_id: "forge-1-8-9-pvp".to_string(),
            selected_version_id: "1.8.9 Forge".to_string(),
            selected_modpack_id: "1.8.9 PvP".to_string(),
            accent_color: "#66d9ff".to_string(),
            background_animation: true,
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve config directory: {error}"))?;

    fs::create_dir_all(&config_dir)
        .map_err(|error| format!("Could not create config directory: {error}"))?;

    Ok(config_dir.join("launcher-config.json"))
}

#[tauri::command]
fn load_launcher_config(app: tauri::AppHandle) -> Result<LauncherConfig, String> {
    let path = config_path(&app)?;

    if !path.exists() {
        let config = LauncherConfig::default();
        save_launcher_config(app, config.clone())?;
        return Ok(config);
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read launcher config: {error}"))?;

    serde_json::from_str(&raw).map_err(|error| format!("Could not parse launcher config: {error}"))
}

#[tauri::command]
fn save_launcher_config(app: tauri::AppHandle, config: LauncherConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    let raw = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Could not serialize launcher config: {error}"))?;

    fs::write(path, raw).map_err(|error| format!("Could not write launcher config: {error}"))
}

#[tauri::command]
fn load_accounts(auth: tauri::State<AuthRuntime>) -> Result<Vec<AccountSummary>, String> {
    auth.accounts
        .lock()
        .map(|accounts| accounts.clone())
        .map_err(|_| "Could not lock account list".to_string())
}

#[tauri::command]
fn start_microsoft_login(
    app: tauri::AppHandle,
    auth: tauri::State<AuthRuntime>,
) -> Result<AuthStart, String> {
    let client_id = std::env::var("HELIX_MICROSOFT_CLIENT_ID").unwrap_or_default();
    let redirect_uri = std::env::var("HELIX_MICROSOFT_REDIRECT_URI")
        .unwrap_or_else(|_| DEFAULT_REDIRECT_URI.to_string());
    let state = random_url_token(32);
    let code_verifier = random_url_token(96);
    let code_challenge = pkce_challenge(&code_verifier);
    let client_configured = !client_id.trim().is_empty();
    let requested_client_id = if client_configured {
        client_id.as_str()
    } else {
        "configure-HELIX_MICROSOFT_CLIENT_ID"
    };

    let auth_url = format!(
        "{MICROSOFT_AUTHORITY}/authorize?client_id={}&response_type=code&redirect_uri={}&response_mode=query&scope={}&state={}&code_challenge={}&code_challenge_method=S256&prompt=select_account",
        urlencoding::encode(requested_client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(MINECRAFT_SCOPES),
        urlencoding::encode(&state),
        urlencoding::encode(&code_challenge)
    );

    let pending = PendingMicrosoftAuth {
        state: state.clone(),
        code_verifier,
        redirect_uri: redirect_uri.clone(),
        authorization_code: None,
    };

    *auth
        .pending
        .lock()
        .map_err(|_| "Could not lock auth runtime".to_string())? = Some(pending);
    ensure_callback_listener(&app, &auth)?;

    let message = if client_configured {
        "Microsoft OAuth popup is ready. Complete the browser login and Helix will capture the callback automatically."
    } else {
        "Microsoft OAuth is ready, but HELIX_MICROSOFT_CLIENT_ID is not configured yet."
    };

    Ok(AuthStart {
        auth_url,
        state,
        redirect_uri,
        scopes: MINECRAFT_SCOPES.to_string(),
        client_configured,
        message: message.to_string(),
    })
}

#[tauri::command]
fn logout_account(auth: tauri::State<AuthRuntime>, account_id: String) -> Result<(), String> {
    let mut accounts = auth
        .accounts
        .lock()
        .map_err(|_| "Could not lock account list".to_string())?;
    accounts.retain(|account| account.id != account_id);
    Ok(())
}

#[tauri::command]
fn complete_microsoft_callback(
    auth: tauri::State<AuthRuntime>,
    callback_url: String,
    _expected_state: Option<String>,
) -> Result<AuthCallbackResult, String> {
    let query = callback_url
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or(callback_url.as_str());
    let code = query_param(query, "code");
    let returned_state = query_param(query, "state").unwrap_or_default();
    let mut pending = auth
        .pending
        .lock()
        .map_err(|_| "Could not lock auth runtime".to_string())?;
    let state_valid = pending
        .as_ref()
        .map(|pending| pending.state == returned_state)
        .unwrap_or(false);

    let ready_for_token_exchange = code.is_some() && state_valid;
    if ready_for_token_exchange {
        if let Some(pending) = pending.as_mut() {
            pending.authorization_code = code.clone();
        }
    }
    let message = if ready_for_token_exchange {
        "Authorization code accepted. Token exchange, Xbox Live, XSTS and Minecraft Services are next."
    } else {
        "Callback could not be accepted. Check the returned state and authorization code."
    };

    Ok(AuthCallbackResult {
        code_received: code.is_some(),
        state: returned_state,
        state_valid,
        ready_for_token_exchange,
        message: message.to_string(),
    })
}

fn ensure_callback_listener(
    app: &tauri::AppHandle,
    auth: &tauri::State<AuthRuntime>,
) -> Result<(), String> {
    let mut started = auth
        .callback_listener_started
        .lock()
        .map_err(|_| "Could not lock callback listener state".to_string())?;
    if *started {
        return Ok(());
    }

    let listener = TcpListener::bind("127.0.0.1:48189")
        .map_err(|error| format!("Could not start OAuth callback listener: {error}"))?;
    let app = app.clone();

    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                continue;
            };

            let mut buffer = [0_u8; 4096];
            let Ok(size) = stream.read(&mut buffer) else {
                continue;
            };
            let request = String::from_utf8_lossy(&buffer[..size]);
            let Some(first_line) = request.lines().next() else {
                continue;
            };
            let Some(path) = first_line.split_whitespace().nth(1) else {
                continue;
            };

            let result = if path.starts_with("/auth/microsoft/callback") {
                let callback_url = format!("http://localhost:48189{path}");
                handle_callback_url(&app, &callback_url)
            } else {
                AuthCallbackResult {
                    code_received: false,
                    state: String::new(),
                    state_valid: false,
                    ready_for_token_exchange: false,
                    message: "Unexpected OAuth callback path.".to_string(),
                }
            };

            let page = if result.ready_for_token_exchange {
                callback_success_page()
            } else {
                callback_error_page(&result.message)
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                page.len(),
                page
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = app.emit("helix://auth-callback", result);
        }
    });

    *started = true;
    Ok(())
}

fn handle_callback_url(app: &tauri::AppHandle, callback_url: &str) -> AuthCallbackResult {
    let auth = app.state::<AuthRuntime>();
    let query = callback_url
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or(callback_url);
    let code = query_param(query, "code");
    let returned_state = query_param(query, "state").unwrap_or_default();

    let Ok(mut pending) = auth.pending.lock() else {
        return AuthCallbackResult {
            code_received: code.is_some(),
            state: returned_state,
            state_valid: false,
            ready_for_token_exchange: false,
            message: "Could not lock auth runtime.".to_string(),
        };
    };
    let state_valid = pending
        .as_ref()
        .map(|pending| pending.state == returned_state)
        .unwrap_or(false);
    let ready_for_token_exchange = code.is_some() && state_valid;

    if ready_for_token_exchange {
        if let Some(pending) = pending.as_mut() {
            pending.authorization_code = code.clone();
        }
    }

    AuthCallbackResult {
        code_received: code.is_some(),
        state: returned_state,
        state_valid,
        ready_for_token_exchange,
        message: if ready_for_token_exchange {
            "Authorization code accepted. You can close this login window."
        } else {
            "Callback could not be accepted. Check the returned state and authorization code."
        }
        .to_string(),
    }
}

fn callback_success_page() -> String {
    callback_page(
        "Helix login complete",
        "Microsoft login was captured. You can return to Helix Client.",
    )
}

fn callback_error_page(message: &str) -> String {
    callback_page("Helix login failed", message)
}

fn callback_page(title: &str, message: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <style>
      body {{
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #06080d;
        color: #eef8ff;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }}
      main {{
        max-width: 420px;
        padding: 28px;
        border: 1px solid rgba(150, 210, 240, 0.18);
        border-radius: 8px;
        background: rgba(12, 22, 34, 0.92);
        text-align: center;
      }}
      p {{ color: #b5c7d4; }}
    </style>
  </head>
  <body>
    <main>
      <h1>{title}</h1>
      <p>{message}</p>
    </main>
    <script>
      window.setTimeout(() => window.close(), 1400);
    </script>
  </body>
</html>"#
    )
}

#[tauri::command]
fn exchange_microsoft_tokens(
    auth: tauri::State<AuthRuntime>,
) -> Result<AuthExchangeResult, String> {
    let client_id = std::env::var("HELIX_MICROSOFT_CLIENT_ID").unwrap_or_default();
    if client_id.trim().is_empty() {
        return Ok(AuthExchangeResult {
            account: None,
            stage: "configuration".to_string(),
            success: false,
            message: "HELIX_MICROSOFT_CLIENT_ID is required before token exchange can run."
                .to_string(),
        });
    }

    let pending = auth
        .pending
        .lock()
        .map_err(|_| "Could not lock auth runtime".to_string())?
        .clone()
        .ok_or_else(|| "Start Microsoft login before token exchange.".to_string())?;
    let authorization_code = pending
        .authorization_code
        .ok_or_else(|| "Validate the OAuth callback before token exchange.".to_string())?;

    let microsoft = exchange_authorization_code(
        &client_id,
        &pending.redirect_uri,
        &pending.code_verifier,
        &authorization_code,
    )?;
    let xbox = authenticate_xbox_live(&microsoft.access_token)?;
    let xsts = authorize_xsts(&xbox.token)?;
    let user_hash = xsts
        .display_claims
        .xui
        .first()
        .map(|claim| claim.uhs.clone())
        .ok_or_else(|| "XSTS response did not include a user hash.".to_string())?;
    let minecraft = login_minecraft(&user_hash, &xsts.token)?;
    let profile = fetch_minecraft_profile(&minecraft.access_token)?;
    let owns_java = validate_minecraft_ownership(&minecraft.access_token)?;

    let account = AccountSummary {
        id: profile.id.clone(),
        username: profile.name,
        uuid: profile.id,
        avatar_url: None,
        owns_java,
        active: true,
    };

    let mut accounts = auth
        .accounts
        .lock()
        .map_err(|_| "Could not lock account list".to_string())?;
    for existing in accounts.iter_mut() {
        existing.active = false;
    }
    accounts.retain(|existing| existing.id != account.id);
    accounts.push(account.clone());

    Ok(AuthExchangeResult {
        account: Some(account),
        stage: "minecraft_profile".to_string(),
        success: true,
        message: "Microsoft, Xbox Live, XSTS and Minecraft Services auth completed.".to_string(),
    })
}

fn exchange_authorization_code(
    client_id: &str,
    redirect_uri: &str,
    code_verifier: &str,
    authorization_code: &str,
) -> Result<MicrosoftTokenResponse, String> {
    let client_secret = std::env::var("HELIX_MICROSOFT_CLIENT_SECRET").unwrap_or_default();
    let mut form = vec![
        ("client_id", client_id),
        ("scope", MINECRAFT_SCOPES),
        ("code", authorization_code),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
        ("code_verifier", code_verifier),
    ];

    if !client_secret.trim().is_empty() {
        form.push(("client_secret", client_secret.as_str()));
    }

    match ureq::post(&format!("{MICROSOFT_AUTHORITY}/token"))
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_form(&form)
    {
        Ok(response) => response
            .into_json()
            .map_err(|error| format!("Could not parse Microsoft token response: {error}")),
        Err(error) => Err(auth_http_error("microsoft_token")(error)),
    }
}

fn authenticate_xbox_live(access_token: &str) -> Result<XboxAuthResponse, String> {
    ureq::post("https://user.auth.xboxlive.com/user/authenticate")
        .set("Content-Type", "application/json")
        .send_json(json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={access_token}")
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }))
        .map_err(auth_http_error("xbox_live"))?
        .into_json()
        .map_err(|error| format!("Could not parse Xbox Live response: {error}"))
}

fn authorize_xsts(xbox_token: &str) -> Result<XboxAuthResponse, String> {
    ureq::post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .set("Content-Type", "application/json")
        .send_json(json!({
            "Properties": {
                "SandboxId": "RETAIL",
                "UserTokens": [xbox_token]
            },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }))
        .map_err(auth_http_error("xsts"))?
        .into_json()
        .map_err(|error| format!("Could not parse XSTS response: {error}"))
}

fn login_minecraft(user_hash: &str, xsts_token: &str) -> Result<MinecraftAuthResponse, String> {
    ureq::post("https://api.minecraftservices.com/authentication/login_with_xbox")
        .set("Content-Type", "application/json")
        .send_json(json!({
            "identityToken": format!("XBL3.0 x={user_hash};{xsts_token}")
        }))
        .map_err(auth_http_error("minecraft_login"))?
        .into_json()
        .map_err(|error| format!("Could not parse Minecraft login response: {error}"))
}

fn fetch_minecraft_profile(access_token: &str) -> Result<MinecraftProfileResponse, String> {
    ureq::get("https://api.minecraftservices.com/minecraft/profile")
        .set("Authorization", &format!("Bearer {access_token}"))
        .call()
        .map_err(auth_http_error("minecraft_profile"))?
        .into_json()
        .map_err(|error| format!("Could not parse Minecraft profile response: {error}"))
}

fn validate_minecraft_ownership(access_token: &str) -> Result<bool, String> {
    let response: MinecraftEntitlementsResponse =
        ureq::get("https://api.minecraftservices.com/entitlements/mcstore")
            .set("Authorization", &format!("Bearer {access_token}"))
            .call()
            .map_err(auth_http_error("minecraft_entitlements"))?
            .into_json()
            .map_err(|error| format!("Could not parse Minecraft entitlements response: {error}"))?;

    Ok(response
        .items
        .iter()
        .any(|item| item.name == "game_minecraft" || item.name == "product_minecraft"))
}

fn auth_http_error(stage: &'static str) -> impl FnOnce(ureq::Error) -> String {
    move |error| match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_else(|_| String::new());
            let detail = oauth_error_detail(&body);
            if detail.is_empty() {
                format!("{stage} request failed with HTTP {status}.")
            } else {
                format!("{stage} request failed with HTTP {status}: {detail}")
            }
        }
        ureq::Error::Transport(error) => format!("{stage} request failed: {error}"),
    }
}

fn oauth_error_detail(body: &str) -> String {
    if body.trim().is_empty() {
        return String::new();
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        let mut parts = Vec::new();
        let error = value
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("oauth_error");
        parts.push(error.to_string());

        if let Some(description) = value
            .get("error_description")
            .and_then(|value| value.as_str())
        {
            parts.push(description.to_string());
        }

        for key in ["errorMessage", "message", "path", "developerMessage"] {
            if let Some(detail) = value.get(key).and_then(|value| value.as_str()) {
                parts.push(format!("{key}: {detail}"));
            }
        }

        return sanitize_oauth_error(&parts.join(" | "));
    }

    sanitize_oauth_error(body)
}

fn sanitize_oauth_error(message: &str) -> String {
    let compact = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let hint = if compact.contains("AADSTS70002") || compact.contains("client_secret") {
        " Hint: this Azure app is still being treated as a confidential Web app for the redirect URI. Add the redirect URI under 'Mobile and desktop applications' or provide HELIX_MICROSOFT_CLIENT_SECRET."
    } else if compact.contains("Invalid app registration") || compact.contains("AppRegInfo") {
        " Hint: Minecraft Services rejected this Azure app registration. Use an app registration approved for Minecraft Services or request access via https://aka.ms/AppRegInfo."
    } else {
        ""
    };
    format!("{}{}", compact.chars().take(900).collect::<String>(), hint)
}

fn random_url_token(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn pkce_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (pair_key, value) = pair.split_once('=')?;
        if pair_key == key {
            urlencoding::decode(value)
                .ok()
                .map(|value| value.into_owned())
        } else {
            None
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AuthRuntime::default())
        .invoke_handler(tauri::generate_handler![
            load_launcher_config,
            save_launcher_config,
            load_accounts,
            start_microsoft_login,
            logout_account,
            complete_microsoft_callback,
            exchange_microsoft_tokens
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helix Client launcher");
}
