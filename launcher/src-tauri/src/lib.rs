use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command,
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
    #[serde(default)]
    custom_java_path: Option<String>,
    #[serde(default)]
    custom_minecraft_path: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemDetection {
    minecraft: MinecraftPathStatus,
    java: JavaDetection,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MinecraftPathStatus {
    path: Option<String>,
    exists: bool,
    versions_dir_exists: bool,
    mods_dir_exists: bool,
    launcher_profiles_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaDetection {
    installations: Vec<JavaInstallation>,
    java8: Option<JavaInstallation>,
    modern: Option<JavaInstallation>,
    custom: Option<JavaInstallation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaInstallation {
    path: String,
    version: Option<String>,
    major_version: Option<u32>,
    source: String,
    supports_1_8_9: bool,
    supports_modern: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchPlanRequest {
    profile_id: String,
    profile_name: String,
    version_id: String,
    version_label: String,
    minecraft_version: String,
    loader: String,
    modpack_id: String,
    modpack_name: String,
    java_target: String,
    memory_mb: u32,
    resolution: String,
    account_username: Option<String>,
    account_uuid: Option<String>,
    owns_java: bool,
    required_mods: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchPlan {
    session_id: String,
    dry_run: bool,
    profile_name: String,
    minecraft_dir: Option<String>,
    game_dir: String,
    java_path: Option<String>,
    arguments_preview: Vec<String>,
    stages: Vec<LaunchStage>,
    blockers: Vec<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchStage {
    id: String,
    label: String,
    status: String,
    detail: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryRequest {
    profiles: Vec<serde_json::Value>,
    versions: Vec<serde_json::Value>,
    modpacks: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLibraryStatus {
    root_dir: String,
    created_dirs: Vec<String>,
    written_files: Vec<String>,
    message: String,
}

impl Default for LauncherConfig {
    fn default() -> Self {
        Self {
            selected_profile_id: "forge-1-8-9-pvp".to_string(),
            selected_version_id: "1.8.9-forge".to_string(),
            selected_modpack_id: "pvp-1-8-9".to_string(),
            accent_color: "#66d9ff".to_string(),
            background_animation: true,
            custom_java_path: None,
            custom_minecraft_path: None,
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
fn detect_system_paths(app: tauri::AppHandle) -> Result<SystemDetection, String> {
    let config = load_launcher_config(app)?;
    let minecraft = detect_minecraft_path(config.custom_minecraft_path.as_deref());
    let java = detect_java_installations(config.custom_java_path.as_deref());
    let message = match (
        minecraft.exists,
        java.java8.is_some(),
        java.modern.is_some(),
    ) {
        (true, true, true) => "Minecraft folder, Java 8 and modern Java are ready.",
        (true, false, true) => {
            "Minecraft folder and modern Java found. Java 8 is still needed for 1.8.9."
        }
        (true, true, false) => {
            "Minecraft folder and Java 8 found. Java 21+ is still needed for modern versions."
        }
        (true, false, false) => {
            "Minecraft folder found, but no suitable Java runtime was detected."
        }
        (false, _, _) => "Minecraft folder was not found or the configured path is invalid.",
    };

    Ok(SystemDetection {
        minecraft,
        java,
        message: message.to_string(),
    })
}

#[tauri::command]
fn prepare_launch_plan(
    app: tauri::AppHandle,
    request: LaunchPlanRequest,
) -> Result<LaunchPlan, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve config directory: {error}"))?;
    let game_dir = config_dir
        .join("profiles")
        .join(&request.profile_id)
        .to_string_lossy()
        .into_owned();
    let system = detect_system_paths(app)?;
    let java = if request.java_target == "Java 8" {
        system.java.java8.clone()
    } else {
        system.java.modern.clone()
    };
    let mut blockers = Vec::new();

    if request
        .account_username
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push("Microsoft account is missing.".to_string());
    }
    if !request.owns_java {
        blockers.push("Minecraft Java ownership is not validated.".to_string());
    }
    if !system.minecraft.exists {
        blockers.push("Minecraft folder is missing or the configured path is invalid.".to_string());
    }
    if java.is_none() {
        blockers.push(format!("{} runtime is missing.", request.java_target));
    }

    let arguments_preview = build_arguments_preview(&request, &game_dir);
    let stages = vec![
        launch_stage(
            "preflight",
            "Preflight",
            blockers.is_empty(),
            if blockers.is_empty() {
                "Account, ownership, Java and paths are ready.".to_string()
            } else {
                blockers.join(" ")
            },
        ),
        launch_stage(
            "directories",
            "Prepare directories",
            system.minecraft.exists,
            format!("Game directory: {game_dir}"),
        ),
        launch_stage(
            "versions",
            "Resolve Minecraft version",
            true,
            format!(
                "{} using {} loader ({})",
                request.minecraft_version, request.loader, request.version_id
            ),
        ),
        launch_stage(
            "modpack",
            "Apply modpack manifest",
            true,
            if request.required_mods.is_empty() {
                format!("{} has no required mod entries.", request.modpack_name)
            } else {
                format!(
                    "{} ({}) requires {} mods: {}",
                    request.modpack_name,
                    request.modpack_id,
                    request.required_mods.len(),
                    request.required_mods.join(", ")
                )
            },
        ),
        launch_stage(
            "process",
            "Spawn Minecraft process",
            blockers.is_empty(),
            "Dry run only. Process execution is intentionally disabled in this step.".to_string(),
        ),
    ];
    let message = if blockers.is_empty() {
        "Launch plan prepared. Execution layer is next.".to_string()
    } else {
        format!("Launch plan prepared with {} blocker(s).", blockers.len())
    };

    Ok(LaunchPlan {
        session_id: random_url_token(16),
        dry_run: true,
        profile_name: request.profile_name,
        minecraft_dir: system.minecraft.path,
        game_dir,
        java_path: java.map(|java| java.path),
        arguments_preview,
        stages,
        blockers,
        message,
    })
}

#[tauri::command]
fn prepare_local_library(
    app: tauri::AppHandle,
    request: LocalLibraryRequest,
) -> Result<LocalLibraryStatus, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    let mut created_dirs = Vec::new();
    let mut written_files = Vec::new();

    for path in local_library_dirs(&root) {
        fs::create_dir_all(&path)
            .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
        created_dirs.push(path.to_string_lossy().into_owned());
    }

    write_manifest_collection(
        &root.join("manifests").join("profiles"),
        &request.profiles,
        &mut written_files,
    )?;
    write_manifest_collection(
        &root.join("manifests").join("versions"),
        &request.versions,
        &mut written_files,
    )?;
    write_manifest_collection(
        &root.join("manifests").join("modpacks"),
        &request.modpacks,
        &mut written_files,
    )?;

    for profile in &request.profiles {
        let Some(profile_id) = manifest_id(profile) else {
            continue;
        };
        for segment in ["mods", "config", "logs", "resourcepacks"] {
            let path = root.join("profiles").join(&profile_id).join(segment);
            fs::create_dir_all(&path)
                .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
            created_dirs.push(path.to_string_lossy().into_owned());
        }
    }

    let index = json!({
        "generatedAt": chrono_like_timestamp(),
        "profileCount": request.profiles.len(),
        "versionCount": request.versions.len(),
        "modpackCount": request.modpacks.len(),
        "schemaVersion": 1
    });
    let index_path = root.join("manifests").join("index.json");
    fs::write(
        &index_path,
        serde_json::to_string_pretty(&index)
            .map_err(|error| format!("Could not serialize manifest index: {error}"))?,
    )
    .map_err(|error| format!("Could not write {}: {error}", index_path.display()))?;
    written_files.push(index_path.to_string_lossy().into_owned());

    Ok(LocalLibraryStatus {
        root_dir: root.to_string_lossy().into_owned(),
        created_dirs,
        written_files,
        message: "Local Helix library prepared.".to_string(),
    })
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

fn detect_minecraft_path(custom_minecraft_path: Option<&str>) -> MinecraftPathStatus {
    if let Some(custom) = custom_minecraft_path.filter(|path| !path.trim().is_empty()) {
        return minecraft_path_status(PathBuf::from(custom));
    }

    let mut candidates = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(PathBuf::from(appdata).join(".minecraft"));
    }
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        candidates.push(
            PathBuf::from(user_profile)
                .join("AppData")
                .join("Roaming")
                .join(".minecraft"),
        );
    }

    let path = candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .unwrap_or_else(default_minecraft_path);

    minecraft_path_status(path)
}

fn minecraft_path_status(path: PathBuf) -> MinecraftPathStatus {
    MinecraftPathStatus {
        exists: path.exists(),
        versions_dir_exists: path.join("versions").exists(),
        mods_dir_exists: path.join("mods").exists(),
        launcher_profiles_exists: path.join("launcher_profiles.json").exists(),
        path: Some(path.to_string_lossy().into_owned()),
    }
}

fn default_minecraft_path() -> PathBuf {
    std::env::var("APPDATA")
        .map(|appdata| PathBuf::from(appdata).join(".minecraft"))
        .unwrap_or_else(|_| PathBuf::from(".minecraft"))
}

fn detect_java_installations(custom_java_path: Option<&str>) -> JavaDetection {
    let mut candidates = Vec::new();

    if let Some(custom) = custom_java_path.filter(|path| !path.trim().is_empty()) {
        candidates.push((PathBuf::from(custom), "Custom path".to_string()));
    }

    if let Ok(java_home) = std::env::var("JAVA_HOME") {
        candidates.push((
            PathBuf::from(java_home).join("bin").join("java.exe"),
            "JAVA_HOME".to_string(),
        ));
    }

    if let Ok(path) = std::env::var("PATH") {
        for entry in std::env::split_paths(&path) {
            candidates.push((entry.join("java.exe"), "PATH".to_string()));
        }
    }

    for root in java_search_roots() {
        collect_java_candidates(&root, "Installed runtime", &mut candidates);
    }

    let mut seen = HashSet::new();
    let mut installations = Vec::new();
    let mut custom = None;

    for (path, source) in candidates {
        if !path.exists() || !path.is_file() {
            continue;
        }

        let canonical = path.canonicalize().unwrap_or(path);
        let key = canonical.to_string_lossy().to_lowercase();
        if !seen.insert(key) {
            continue;
        }

        let installation = inspect_java(&canonical, &source);
        if source == "Custom path" {
            custom = Some(installation.clone());
        }
        installations.push(installation);
    }

    installations.sort_by(|left, right| {
        right
            .major_version
            .cmp(&left.major_version)
            .then_with(|| left.path.cmp(&right.path))
    });

    let java8 = installations
        .iter()
        .find(|java| java.supports_1_8_9)
        .cloned();
    let modern = installations
        .iter()
        .find(|java| java.supports_modern)
        .cloned();

    JavaDetection {
        installations,
        java8,
        modern,
        custom,
    }
}

fn java_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for base in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(program_files) = std::env::var(base) {
            let root = PathBuf::from(program_files);
            for vendor in [
                "Java",
                "Eclipse Adoptium",
                "Microsoft",
                "Zulu",
                "BellSoft",
                "Amazon Corretto",
            ] {
                roots.push(root.join(vendor));
            }
        }
    }
    roots
}

fn collect_java_candidates(root: &Path, source: &str, candidates: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        candidates.push((path.join("bin").join("java.exe"), source.to_string()));
    }
}

fn inspect_java(path: &Path, source: &str) -> JavaInstallation {
    let version_output = Command::new(path)
        .arg("-version")
        .output()
        .ok()
        .map(|output| {
            let mut text = String::from_utf8_lossy(&output.stderr).to_string();
            if text.trim().is_empty() {
                text = String::from_utf8_lossy(&output.stdout).to_string();
            }
            text
        });
    let version = version_output
        .as_deref()
        .and_then(|output| output.lines().next())
        .map(|line| line.trim().to_string());
    let major_version = version.as_deref().and_then(parse_java_major_version);

    JavaInstallation {
        path: path.to_string_lossy().into_owned(),
        version,
        major_version,
        source: source.to_string(),
        supports_1_8_9: major_version == Some(8),
        supports_modern: major_version.is_some_and(|major| major >= 21),
    }
}

fn parse_java_major_version(line: &str) -> Option<u32> {
    let quoted = line.split('"').nth(1)?;
    let first = quoted.split('.').next()?;
    if first == "1" {
        quoted.split('.').nth(1)?.parse().ok()
    } else {
        first.parse().ok()
    }
}

fn local_library_dirs(root: &Path) -> Vec<PathBuf> {
    [
        "cache",
        "cache/assets",
        "cache/downloads",
        "logs",
        "manifests",
        "manifests/modpacks",
        "manifests/profiles",
        "manifests/versions",
        "profiles",
        "runtime",
        "runtime/mods",
        "versions",
    ]
    .iter()
    .map(|segment| root.join(segment))
    .collect()
}

fn write_manifest_collection(
    dir: &Path,
    manifests: &[serde_json::Value],
    written_files: &mut Vec<String>,
) -> Result<(), String> {
    for manifest in manifests {
        let id =
            manifest_id(manifest).ok_or_else(|| "Manifest is missing an id field.".to_string())?;
        let path = dir.join(format!("{id}.json"));
        let raw = serde_json::to_string_pretty(manifest)
            .map_err(|error| format!("Could not serialize manifest {id}: {error}"))?;
        fs::write(&path, raw)
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        written_files.push(path.to_string_lossy().into_owned());
    }
    Ok(())
}

fn manifest_id(value: &serde_json::Value) -> Option<String> {
    value
        .get("id")
        .and_then(|value| value.as_str())
        .filter(|id| !id.trim().is_empty())
        .map(|id| {
            id.chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                })
                .collect()
        })
}

fn chrono_like_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn build_arguments_preview(request: &LaunchPlanRequest, game_dir: &str) -> Vec<String> {
    vec![
        format!("-Xmx{}M", request.memory_mb),
        "-Dhelix.launcher=true".to_string(),
        "-Dhelix.dryRun=true".to_string(),
        "net.minecraft.client.main.Main".to_string(),
        "--username".to_string(),
        request
            .account_username
            .clone()
            .unwrap_or_else(|| "offline-preview".to_string()),
        "--uuid".to_string(),
        request
            .account_uuid
            .clone()
            .unwrap_or_else(|| "00000000000000000000000000000000".to_string()),
        "--version".to_string(),
        request.version_label.clone(),
        "--gameDir".to_string(),
        game_dir.to_string(),
        "--width".to_string(),
        request
            .resolution
            .split('x')
            .next()
            .unwrap_or("1280")
            .to_string(),
        "--height".to_string(),
        request
            .resolution
            .split('x')
            .nth(1)
            .unwrap_or("720")
            .to_string(),
    ]
}

fn launch_stage(id: &str, label: &str, ok: bool, detail: String) -> LaunchStage {
    LaunchStage {
        id: id.to_string(),
        label: label.to_string(),
        status: if ok { "ready" } else { "blocked" }.to_string(),
        detail,
    }
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
            detect_system_paths,
            prepare_launch_plan,
            prepare_local_library,
            load_accounts,
            start_microsoft_login,
            logout_account,
            complete_microsoft_callback,
            exchange_microsoft_tokens
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helix Client launcher");
}
