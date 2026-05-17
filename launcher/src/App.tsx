import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Coffee,
  Dna,
  ExternalLink,
  Folder,
  LogOut,
  Play,
  Power,
  RefreshCw,
  ShieldCheck,
  UserRound
} from "lucide-react";
import {
  beginMicrosoftLogin,
  completeMicrosoftCallback,
  exchangeMicrosoftTokens,
  isDesktopRuntime,
  loadAccounts,
  logoutAccount,
  type AuthCallbackResult,
  type AuthExchangeResult,
  type AccountSummary,
  type AuthStart,
  type AuthStatus
} from "./auth";
import { defaultConfig, loadLauncherConfig, saveLauncherConfig, type LauncherConfig } from "./config";
import { launchProfile, navItems } from "./data";
import { detectSystemPaths, type JavaInstallation, type SystemDetection } from "./system";

type ConfigState = {
  config: LauncherConfig;
  loaded: boolean;
  status: string;
};

type AccountState = {
  accounts: AccountSummary[];
  status: AuthStatus;
  message: string;
  authStart?: AuthStart;
  callbackResult?: AuthCallbackResult;
  exchangeResult?: AuthExchangeResult;
};

type SystemState = {
  detection?: SystemDetection;
  status: "idle" | "loading" | "ready" | "error";
  message: string;
};

export function App() {
  const [activeSection, setActiveSection] = useState("home");
  const [configState, setConfigState] = useState<ConfigState>({
    config: defaultConfig,
    loaded: false,
    status: "Loading local launcher config"
  });
  const [accountState, setAccountState] = useState<AccountState>({
    accounts: [],
    status: "loading",
    message: "Loading accounts"
  });
  const [systemState, setSystemState] = useState<SystemState>({
    status: "idle",
    message: "System paths not scanned yet"
  });

  useEffect(() => {
    let isMounted = true;

    loadLauncherConfig()
      .then((config) => {
        if (!isMounted) return;
        setConfigState({
          config,
          loaded: true,
          status: "Local launcher config loaded"
        });
      })
      .catch((error) => {
        if (!isMounted) return;
        setConfigState({
          config: defaultConfig,
          loaded: true,
          status: `Using defaults: ${String(error)}`
        });
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    void handleSystemScan();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<AuthCallbackResult>("helix://auth-callback", (event) => {
      const callbackResult = event.payload;
      setAccountState((current) => ({
        ...current,
        callbackResult,
        status: callbackResult.readyForTokenExchange ? "loading" : "error",
        message: callbackResult.readyForTokenExchange
          ? "Microsoft login captured. Completing Minecraft authentication."
          : callbackResult.message
      }));

      if (callbackResult.readyForTokenExchange) {
        void handleTokenExchange();
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    loadAccounts()
      .then((accounts) => {
        if (!isMounted) return;
        setAccountState({
          accounts,
          status: "ready",
          message: accounts.length === 0 ? "No Microsoft account connected" : "Account data loaded"
        });
      })
      .catch((error) => {
        if (!isMounted) return;
        setAccountState({
          accounts: [],
          status: "error",
          message: `Could not load accounts: ${String(error)}`
        });
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const activeLabel = useMemo(
    () => navItems.find((item) => item.id === activeSection)?.label ?? "Home",
    [activeSection]
  );
  const activeAccount = accountState.accounts.find((account) => account.active) ?? accountState.accounts[0];
  const accountLabel = activeAccount?.username ?? "Offline setup";

  async function toggleAnimation() {
    const nextConfig = {
      ...configState.config,
      backgroundAnimation: !configState.config.backgroundAnimation
    };

    setConfigState((current) => ({
      ...current,
      config: nextConfig,
      status: "Saving launcher config"
    }));

    await saveLauncherConfig(nextConfig);

    setConfigState((current) => ({
      ...current,
      status: "Launcher config saved"
    }));
  }

  async function handleMicrosoftLogin() {
    setAccountState((current) => ({
      ...current,
      status: "loading",
      message: "Preparing Microsoft OAuth"
    }));

    try {
      const authStart = await beginMicrosoftLogin();
      setAccountState((current) => ({
        ...current,
        authStart,
        status: "blocked",
        message: authStart.message
      }));
      if (authStart.clientConfigured) {
        openMicrosoftPopup(authStart.authUrl);
      }
    } catch (error) {
      setAccountState((current) => ({
        ...current,
        status: "error",
        message: `Could not start Microsoft login: ${String(error)}`
      }));
    }
  }

  function openMicrosoftPopup(authUrl: string) {
    const popup = window.open(
      authUrl,
      "helix-microsoft-login",
      "popup=yes,width=520,height=720,menubar=no,toolbar=no,location=yes,status=no"
    );

    if (!popup) {
      setAccountState((current) => ({
        ...current,
        status: "error",
        message: "Could not open Microsoft login popup. Allow popups for Helix Client and try again."
      }));
    }
  }

  async function handleCallback(callbackUrl: string) {
    setAccountState((current) => ({
      ...current,
      status: "loading",
      message: "Validating Microsoft OAuth callback"
    }));

    try {
      const callbackResult = await completeMicrosoftCallback(callbackUrl, accountState.authStart?.state);
      setAccountState((current) => ({
        ...current,
        callbackResult,
        status: callbackResult.readyForTokenExchange ? "blocked" : "error",
        message: callbackResult.message
      }));
    } catch (error) {
      setAccountState((current) => ({
        ...current,
        status: "error",
        message: `Could not validate callback: ${String(error)}`
      }));
    }
  }

  async function handleTokenExchange() {
    setAccountState((current) => ({
      ...current,
      status: "loading",
      message: "Exchanging tokens with Microsoft, Xbox Live and Minecraft Services"
    }));

    try {
      const exchangeResult = await exchangeMicrosoftTokens();
      const accounts = exchangeResult.account ? [exchangeResult.account] : accountState.accounts;
      setAccountState((current) => ({
        ...current,
        accounts,
        exchangeResult,
        status: exchangeResult.success ? "ready" : "error",
        message: exchangeResult.message
      }));
    } catch (error) {
      setAccountState((current) => ({
        ...current,
        status: "error",
        message: `Could not complete Microsoft login: ${String(error)}`
      }));
    }
  }

  async function handleLogout(accountId: string) {
    await logoutAccount(accountId);
    const accounts = await loadAccounts();
    setAccountState({
      accounts,
      status: "ready",
      message: accounts.length === 0 ? "No Microsoft account connected" : "Account data loaded"
    });
  }

  async function handleSystemScan() {
    setSystemState((current) => ({
      ...current,
      status: "loading",
      message: "Scanning Minecraft folder and Java runtimes"
    }));

    try {
      const detection = await detectSystemPaths();
      setSystemState({
        detection,
        status: "ready",
        message: detection.message
      });
    } catch (error) {
      setSystemState({
        status: "error",
        message: `Could not scan system paths: ${String(error)}`
      });
    }
  }

  return (
    <div className="app" data-motion={configState.config.backgroundAnimation ? "on" : "off"}>
      <div className="background-grid" />
      <div className="helix-orbit" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Dna size={24} />
          </div>
          <div>
            <strong>Helix</strong>
            <span>Client</span>
          </div>
        </div>

        <nav className="nav" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={item.id === activeSection ? "nav-item active" : "nav-item"}
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                type="button"
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <button className="account-chip" type="button" onClick={() => setActiveSection("accounts")}>
          <UserRound size={18} />
          <span>{accountLabel}</span>
          <ChevronRight size={16} />
        </button>
      </aside>

      <main className="content">
        {activeSection === "home" ? (
          <HomeScreen accountLabel={activeAccount?.username ?? launchProfile.account} status={configState.status} loaded={configState.loaded} />
        ) : activeSection === "accounts" ? (
          <AccountsScreen
            accountState={accountState}
            onCallback={handleCallback}
            onMicrosoftLogin={handleMicrosoftLogin}
            onTokenExchange={handleTokenExchange}
            onLogout={handleLogout}
          />
        ) : activeSection === "versions" ? (
          <VersionsScreen systemState={systemState} onRefresh={handleSystemScan} />
        ) : activeSection === "settings" ? (
          <SettingsScreen
            backgroundAnimation={configState.config.backgroundAnimation}
            status={configState.status}
            onToggleAnimation={toggleAnimation}
          />
        ) : (
          <PlaceholderScreen section={activeLabel} />
        )}
      </main>
    </div>
  );
}

function VersionsScreen({
  systemState,
  onRefresh
}: {
  systemState: SystemState;
  onRefresh: () => void;
}) {
  const detection = systemState.detection;

  return (
    <section className="versions-screen" aria-labelledby="versions-title">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Runtime detection</p>
          <h1 id="versions-title">Versions</h1>
        </div>
        <button className="icon-label-button" type="button" onClick={onRefresh} disabled={systemState.status === "loading"}>
          <RefreshCw size={18} />
          <span>{systemState.status === "loading" ? "Scanning" : "Refresh"}</span>
        </button>
      </header>

      <div className="system-summary">
        <StatusIcon ok={systemState.status === "ready" && Boolean(detection?.minecraft.exists)} />
        <span>{systemState.message}</span>
      </div>

      <div className="runtime-grid">
        <section className="runtime-panel" aria-labelledby="minecraft-path-title">
          <div className="runtime-panel-title">
            <Folder size={20} />
            <h2 id="minecraft-path-title">Minecraft folder</h2>
          </div>
          {detection ? (
            <>
              <PathValue value={detection.minecraft.path ?? "Not resolved"} />
              <CheckRow label=".minecraft exists" ok={detection.minecraft.exists} />
              <CheckRow label="versions folder" ok={detection.minecraft.versionsDirExists} />
              <CheckRow label="mods folder" ok={detection.minecraft.modsDirExists} />
              <CheckRow label="launcher_profiles.json" ok={detection.minecraft.launcherProfilesExists} />
            </>
          ) : (
            <span className="muted-line">Waiting for the first scan.</span>
          )}
        </section>

        <section className="runtime-panel" aria-labelledby="java-target-title">
          <div className="runtime-panel-title">
            <Coffee size={20} />
            <h2 id="java-target-title">Java targets</h2>
          </div>
          <JavaTarget label="Minecraft 1.8.9" java={detection?.java.java8} required="Java 8" />
          <JavaTarget label="Modern Minecraft" java={detection?.java.modern} required="Java 21+" />
        </section>
      </div>

      <section className="java-list" aria-labelledby="java-list-title">
        <div className="runtime-panel-title">
          <Coffee size={20} />
          <h2 id="java-list-title">Detected Java runtimes</h2>
        </div>
        {detection && detection.java.installations.length > 0 ? (
          detection.java.installations.map((java) => <JavaRow java={java} key={java.path} />)
        ) : (
          <div className="empty-state compact">
            <AlertTriangle size={24} />
            <strong>No Java runtime detected</strong>
            <span>Install Java 8 for 1.8.9 and Java 21 or newer for modern Minecraft profiles.</span>
          </div>
        )}
      </section>
    </section>
  );
}

function JavaTarget({
  java,
  label,
  required
}: {
  java?: JavaInstallation;
  label: string;
  required: string;
}) {
  return (
    <div className="java-target">
      <StatusIcon ok={Boolean(java)} />
      <div>
        <strong>{label}</strong>
        <span>{java ? java.version ?? `Java ${java.majorVersion}` : `${required} required`}</span>
      </div>
    </div>
  );
}

function JavaRow({ java }: { java: JavaInstallation }) {
  return (
    <article className="java-row">
      <div className="java-version">
        <strong>{java.majorVersion ? `Java ${java.majorVersion}` : "Java"}</strong>
        <span>{java.source}</span>
      </div>
      <div>
        <span>{java.version ?? "Version output unavailable"}</span>
        <PathValue value={java.path} />
      </div>
      <div className="java-badges">
        {java.supports189 ? <span>1.8.9</span> : null}
        {java.supportsModern ? <span>Modern</span> : null}
      </div>
    </article>
  );
}

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="check-row">
      <StatusIcon ok={ok} />
      <span>{label}</span>
    </div>
  );
}

function StatusIcon({ ok }: { ok: boolean }) {
  return ok ? <CheckCircle2 className="status-icon ok" size={18} /> : <AlertTriangle className="status-icon warn" size={18} />;
}

function PathValue({ value }: { value: string }) {
  return <code className="path-value">{value}</code>;
}

function HomeScreen({
  accountLabel,
  loaded,
  status
}: {
  accountLabel: string;
  loaded: boolean;
  status: string;
}) {
  return (
    <section className="home-screen" aria-labelledby="home-title">
      <header className="home-topline">
        <div>
          <p className="eyebrow">Launcher Foundation</p>
          <h1 id="home-title">Helix Client</h1>
        </div>
        <div className="profile-pill">
          <Power size={16} />
          <span>{loaded ? "Ready" : "Preparing"}</span>
        </div>
      </header>

      <div className="launch-focus">
        <p className="launch-label">Selected launch profile</p>
        <h2>{launchProfile.name}</h2>
        <dl className="launch-meta">
          <div>
            <dt>Version</dt>
            <dd>{launchProfile.version}</dd>
          </div>
          <div>
            <dt>Modpack</dt>
            <dd>{launchProfile.modpack}</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>{accountLabel}</dd>
          </div>
        </dl>

        <button className="play-button" type="button" disabled>
          <Play size={34} fill="currentColor" />
          <span>Play</span>
        </button>

        <p className="status-line">{status}</p>
      </div>

      <footer className="home-footer">
        <span>{launchProfile.status}</span>
      </footer>
    </section>
  );
}

function AccountsScreen({
  accountState,
  onCallback,
  onMicrosoftLogin,
  onTokenExchange,
  onLogout
}: {
  accountState: AccountState;
  onCallback: (callbackUrl: string) => void;
  onMicrosoftLogin: () => void;
  onTokenExchange: () => void;
  onLogout: (accountId: string) => void;
}) {
  const [callbackUrl, setCallbackUrl] = useState("");

  return (
    <section className="accounts-screen" aria-labelledby="accounts-title">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Account Foundation</p>
          <h1 id="accounts-title">Accounts</h1>
        </div>
        <div className="profile-pill">
          <ShieldCheck size={16} />
          <span>Official login only</span>
        </div>
      </header>

      <div className="account-connect">
        <div>
          <h2>Microsoft account</h2>
          <p>Microsoft sign-in opens in a focused popup. Helix captures the callback automatically.</p>
        </div>
        <button className="primary-action" type="button" onClick={onMicrosoftLogin}>
          <ExternalLink size={20} />
          <span>{accountState.authStart?.clientConfigured ? "Open Microsoft sign-in" : "Prepare Microsoft login"}</span>
        </button>
      </div>

      {!isDesktopRuntime() ? (
        <div className="runtime-warning">
          Browser preview is open. Microsoft token exchange only works in the Helix desktop window.
        </div>
      ) : null}

      <div className="account-status">
        <strong>{accountState.status === "blocked" ? "Next setup required" : "Status"}</strong>
        <span>{accountState.message}</span>
        {accountState.authStart ? (
          <>
            <code>{accountState.authStart.authUrl}</code>
            <dl className="auth-details">
              <div>
                <dt>Redirect URI</dt>
                <dd>{accountState.authStart.redirectUri}</dd>
              </div>
              <div>
                <dt>Scopes</dt>
                <dd>{accountState.authStart.scopes}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>{accountState.authStart.state}</dd>
              </div>
            </dl>
          </>
        ) : null}
      </div>

      {accountState.authStart ? (
        <form
          className="callback-panel"
          onSubmit={(event) => {
            event.preventDefault();
            onCallback(callbackUrl);
          }}
        >
          <label htmlFor="callback-url">OAuth callback URL</label>
          <div>
            <input
              id="callback-url"
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder="http://localhost:48189/auth/microsoft/callback?code=...&state=..."
              type="url"
              value={callbackUrl}
            />
            <button className="secondary-action" disabled={!callbackUrl} type="submit">
              Validate callback
            </button>
          </div>
          {accountState.callbackResult ? (
            <span>
              Code received: {accountState.callbackResult.codeReceived ? "yes" : "no"} | State valid:{" "}
              {accountState.callbackResult.stateValid ? "yes" : "no"}
            </span>
          ) : null}
          {accountState.callbackResult?.readyForTokenExchange ? (
            <button className="secondary-action complete-action" type="button" onClick={onTokenExchange}>
              Complete sign-in
            </button>
          ) : null}
          {accountState.exchangeResult ? (
            <span>
              Exchange stage: {accountState.exchangeResult.stage} | Success:{" "}
              {accountState.exchangeResult.success ? "yes" : "no"}
            </span>
          ) : null}
        </form>
      ) : null}

      <div className="account-list" aria-label="Minecraft accounts">
        {accountState.accounts.length === 0 ? (
          <div className="empty-state">
            <UserRound size={28} />
            <strong>No account connected</strong>
            <span>After Phase 3 this area will show username, UUID, skin head and Java ownership.</span>
          </div>
        ) : (
          accountState.accounts.map((account) => (
            <article className="account-card" key={account.id}>
              <div className="avatar">{account.username.slice(0, 1).toUpperCase()}</div>
              <div>
                <strong>{account.username}</strong>
                <span>{account.uuid}</span>
              </div>
              <span className={account.ownsJava ? "ownership owned" : "ownership"}>{account.ownsJava ? "Java owned" : "Needs validation"}</span>
              <button
                aria-label={`Log out ${account.username}`}
                className="icon-button"
                type="button"
                onClick={() => onLogout(account.id)}
              >
                <LogOut size={18} />
              </button>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function SettingsScreen({
  backgroundAnimation,
  status,
  onToggleAnimation
}: {
  backgroundAnimation: boolean;
  status: string;
  onToggleAnimation: () => void;
}) {
  return (
    <section className="placeholder-screen settings-screen" aria-labelledby="settings-title">
      <p className="eyebrow">Launcher settings</p>
      <h1 id="settings-title">Settings</h1>
      <div className="setting-row">
        <div>
          <strong>Background motion</strong>
          <span>{status}</span>
        </div>
        <button className={backgroundAnimation ? "switch active" : "switch"} type="button" onClick={onToggleAnimation}>
          <span />
        </button>
      </div>
    </section>
  );
}

function PlaceholderScreen({ section }: { section: string }) {
  return (
    <section className="placeholder-screen" aria-labelledby="placeholder-title">
      <p className="eyebrow">Planned screen</p>
      <h1 id="placeholder-title">{section}</h1>
      <p>
        This section is reserved for the next phases. Phase 1 keeps Home clean and testable while the
        launcher foundation settles.
      </p>
    </section>
  );
}
