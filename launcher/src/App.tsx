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
  ListChecks,
  Play,
  Power,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
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
import { navItems } from "./data";
import {
  evaluateLaunchReadiness,
  prepareLaunchPlan,
  type LaunchHistoryEntry,
  type LaunchPlan,
  type LaunchReadiness
} from "./launch";
import {
  getModpack,
  getProfile,
  getProfileForModpack,
  getVersion,
  launchProfiles,
  modpacks,
  type LaunchProfile,
  type ModpackOption
} from "./profiles";
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

type LaunchState = {
  status: "idle" | "loading" | "ready" | "error";
  message: string;
  plan?: LaunchPlan;
};

const launchHistoryKey = "helix-launch-history";

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
  const [launchState, setLaunchState] = useState<LaunchState>({
    status: "idle",
    message: "No launch plan prepared yet"
  });
  const [launchHistory, setLaunchHistory] = useState<LaunchHistoryEntry[]>([]);

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
    const raw = window.localStorage.getItem(launchHistoryKey);
    if (!raw) return;

    try {
      const entries = JSON.parse(raw) as LaunchHistoryEntry[];
      setLaunchHistory(entries.slice(0, 12));
    } catch {
      window.localStorage.removeItem(launchHistoryKey);
    }
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
  const selectedProfile = getProfile(configState.config.selectedProfileId);
  const selectedVersion = getVersion(configState.config.selectedVersionId || selectedProfile.versionId);
  const selectedModpack = getModpack(configState.config.selectedModpackId || selectedProfile.modpackId);
  const launchReadiness = evaluateLaunchReadiness({
    account: activeAccount,
    modpack: selectedModpack,
    profile: selectedProfile,
    system: systemState.detection,
    version: selectedVersion
  });

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

  async function updateCustomJavaPath(customJavaPath?: string) {
    const nextConfig = {
      ...configState.config,
      customJavaPath: customJavaPath?.trim() || undefined
    };

    setConfigState((current) => ({
      ...current,
      config: nextConfig,
      status: "Saving Java runtime path"
    }));

    await saveLauncherConfig(nextConfig);

    setConfigState((current) => ({
      ...current,
      status: nextConfig.customJavaPath ? "Custom Java path saved" : "Custom Java path cleared"
    }));
    await handleSystemScan();
  }

  async function updateCustomMinecraftPath(customMinecraftPath?: string) {
    const nextConfig = {
      ...configState.config,
      customMinecraftPath: customMinecraftPath?.trim() || undefined
    };

    setConfigState((current) => ({
      ...current,
      config: nextConfig,
      status: "Saving Minecraft folder path"
    }));

    await saveLauncherConfig(nextConfig);

    setConfigState((current) => ({
      ...current,
      status: nextConfig.customMinecraftPath ? "Custom Minecraft path saved" : "Custom Minecraft path cleared"
    }));
    await handleSystemScan();
  }

  async function selectProfile(profile: LaunchProfile) {
    const nextConfig = {
      ...configState.config,
      selectedProfileId: profile.id,
      selectedVersionId: profile.versionId,
      selectedModpackId: profile.modpackId
    };

    setConfigState((current) => ({
      ...current,
      config: nextConfig,
      status: `Selected ${profile.name}`
    }));

    await saveLauncherConfig(nextConfig);

    setConfigState((current) => ({
      ...current,
      status: `${profile.name} saved as active profile`
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

  async function handleLaunchAttempt() {
    setLaunchState((current) => ({
      ...current,
      status: "loading",
      message: "Preparing launch plan"
    }));

    try {
      const plan = await prepareLaunchPlan({
        accountUsername: activeAccount?.username,
        accountUuid: activeAccount?.uuid,
        javaTarget: selectedProfile.javaTarget,
        loader: selectedProfile.loader,
        memoryMb: selectedProfile.memoryMb,
        minecraftVersion: selectedProfile.minecraftVersion,
        modpackId: selectedModpack.id,
        modpackName: selectedModpack.name,
        ownsJava: Boolean(activeAccount?.ownsJava),
        profileId: selectedProfile.id,
        profileName: selectedProfile.name,
        requiredMods: selectedModpack.mods.filter((mod) => mod.required).map((mod) => mod.name),
        resolution: selectedProfile.resolution,
        versionId: selectedVersion.id,
        versionLabel: selectedVersion.label
      });
      setLaunchState({
        plan,
        status: plan.blockers.length === 0 ? "ready" : "error",
        message: plan.message
      });
      recordLaunchHistory({
        blockerCount: plan.blockers.length,
        createdAt: new Date().toISOString(),
        gameDir: plan.gameDir,
        id: plan.sessionId,
        javaPath: plan.javaPath,
        message: plan.message,
        profileName: plan.profileName,
        stageCount: plan.stages.length,
        status: plan.blockers.length === 0 ? "ready" : "blocked"
      });
      setConfigState((current) => ({
        ...current,
        status: plan.message
      }));
    } catch (error) {
      const message = `Could not prepare launch plan: ${String(error)}`;
      setLaunchState({
        status: "error",
        message
      });
      recordLaunchHistory({
        blockerCount: 1,
        createdAt: new Date().toISOString(),
        id: `error-${Date.now()}`,
        message,
        profileName: selectedProfile.name,
        stageCount: 0,
        status: "error"
      });
      setConfigState((current) => ({
        ...current,
        status: message
      }));
    }
  }

  function recordLaunchHistory(entry: LaunchHistoryEntry) {
    setLaunchHistory((current) => {
      const next = [entry, ...current].slice(0, 12);
      window.localStorage.setItem(launchHistoryKey, JSON.stringify(next));
      return next;
    });
  }

  function clearLaunchHistory() {
    setLaunchHistory([]);
    window.localStorage.removeItem(launchHistoryKey);
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
          <HomeScreen
            accountLabel={activeAccount?.username ?? "No Microsoft account connected"}
            loaded={configState.loaded}
            modpackName={selectedModpack.name}
            profile={selectedProfile}
            launchState={launchState}
            readiness={launchReadiness}
            status={configState.status}
            versionLabel={selectedVersion.label}
            onLaunchAttempt={handleLaunchAttempt}
          />
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
        ) : activeSection === "profiles" ? (
          <ProfilesScreen
            selectedProfileId={selectedProfile.id}
            status={configState.status}
            onSelectProfile={selectProfile}
          />
        ) : activeSection === "modpacks" ? (
          <ModpacksScreen
            selectedModpackId={selectedModpack.id}
            onSelectModpack={(modpack) => selectProfile(getProfileForModpack(modpack.id))}
          />
        ) : activeSection === "settings" ? (
          <SettingsScreen
            backgroundAnimation={configState.config.backgroundAnimation}
            customJavaPath={configState.config.customJavaPath}
            customMinecraftPath={configState.config.customMinecraftPath}
            status={configState.status}
            onSaveCustomJavaPath={updateCustomJavaPath}
            onSaveCustomMinecraftPath={updateCustomMinecraftPath}
            onToggleAnimation={toggleAnimation}
          />
        ) : activeSection === "logs" ? (
          <LogsScreen entries={launchHistory} onClear={clearLaunchHistory} />
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
  modpackName,
  profile,
  launchState,
  readiness,
  versionLabel,
  status,
  onLaunchAttempt
}: {
  accountLabel: string;
  loaded: boolean;
  modpackName: string;
  profile: LaunchProfile;
  launchState: LaunchState;
  readiness: LaunchReadiness;
  status: string;
  versionLabel: string;
  onLaunchAttempt: () => void;
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
        <h2>{profile.name}</h2>
        <dl className="launch-meta">
          <div>
            <dt>Version</dt>
            <dd>{versionLabel}</dd>
          </div>
          <div>
            <dt>Modpack</dt>
            <dd>{modpackName}</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>{accountLabel}</dd>
          </div>
        </dl>

        <button className="play-button" type="button" onClick={onLaunchAttempt}>
          <Play size={34} fill="currentColor" />
          <span>Play</span>
        </button>

        <p className="status-line">{status}</p>
        <div className="preflight-panel" aria-label="Launch readiness">
          {readiness.checks.map((check) => (
            <div className="preflight-check" key={check.id}>
              <StatusIcon ok={check.ok} />
              <div>
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </div>
            </div>
          ))}
        </div>
        <LaunchPlanPanel launchState={launchState} />
      </div>

      <footer className="home-footer">
        <span>{profile.status}</span>
      </footer>
    </section>
  );
}

function LaunchPlanPanel({ launchState }: { launchState: LaunchState }) {
  if (launchState.status === "idle") {
    return null;
  }

  return (
    <section className="launch-plan-panel" aria-label="Launch plan">
      <div className="launch-plan-header">
        <strong>Launch plan</strong>
        <span>{launchState.message}</span>
      </div>
      {launchState.plan ? (
        <>
          <dl className="launch-plan-meta">
            <div>
              <dt>Session</dt>
              <dd>{launchState.plan.sessionId}</dd>
            </div>
            <div>
              <dt>Java</dt>
              <dd>{launchState.plan.javaPath ?? "Missing"}</dd>
            </div>
            <div>
              <dt>Game dir</dt>
              <dd>{launchState.plan.gameDir}</dd>
            </div>
          </dl>
          <div className="launch-stage-list">
            {launchState.plan.stages.map((stage) => (
              <div className="launch-stage" key={stage.id}>
                <StatusIcon ok={stage.status === "ready"} />
                <div>
                  <strong>{stage.label}</strong>
                  <span>{stage.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function ProfilesScreen({
  selectedProfileId,
  status,
  onSelectProfile
}: {
  selectedProfileId: string;
  status: string;
  onSelectProfile: (profile: LaunchProfile) => void;
}) {
  return (
    <section className="profiles-screen" aria-labelledby="profiles-title">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Launch profiles</p>
          <h1 id="profiles-title">Profiles</h1>
        </div>
        <div className="profile-pill">
          <SlidersHorizontal size={16} />
          <span>{status}</span>
        </div>
      </header>

      <div className="profile-grid">
        {launchProfiles.map((profile) => {
          const active = profile.id === selectedProfileId;
          const version = getVersion(profile.versionId);
          const modpack = getModpack(profile.modpackId);

          return (
            <article className={active ? "profile-card active" : "profile-card"} key={profile.id}>
              <div>
                <span className="profile-kicker">{profile.loader}</span>
                <h2>{profile.name}</h2>
                <p>{profile.status}</p>
              </div>
              <dl className="profile-details">
                <div>
                  <dt>Minecraft</dt>
                  <dd>{version.minecraftVersion}</dd>
                </div>
                <div>
                  <dt>Modpack</dt>
                  <dd>{modpack.name}</dd>
                </div>
                <div>
                  <dt>Java</dt>
                  <dd>{profile.javaTarget}</dd>
                </div>
                <div>
                  <dt>Memory</dt>
                  <dd>{profile.memoryMb} MB</dd>
                </div>
              </dl>
              <button className="secondary-action" type="button" disabled={active} onClick={() => onSelectProfile(profile)}>
                {active ? "Selected" : "Select profile"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ModpacksScreen({
  selectedModpackId,
  onSelectModpack
}: {
  selectedModpackId: string;
  onSelectModpack: (modpack: ModpackOption) => void;
}) {
  return (
    <section className="modpacks-screen" aria-labelledby="modpacks-title">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Modpack catalog</p>
          <h1 id="modpacks-title">Modpacks</h1>
        </div>
        <div className="profile-pill">
          <Folder size={16} />
          <span>Local manifests</span>
        </div>
      </header>

      <div className="modpack-list">
        {modpacks.map((modpack) => {
          const version = getVersion(modpack.versionId);
          const active = modpack.id === selectedModpackId;
          return (
            <article className={active ? "modpack-row active" : "modpack-row"} key={modpack.id}>
              <div className="modpack-main">
                <div>
                  <strong>{modpack.name}</strong>
                  <span>{modpack.summary}</span>
                </div>
                <div className="modpack-mods" aria-label={`${modpack.name} mods`}>
                  {modpack.mods.length > 0 ? (
                    modpack.mods.map((mod) => (
                      <span className={mod.required ? "mod-chip required" : "mod-chip"} key={mod.id}>
                        {mod.name}
                      </span>
                    ))
                  ) : (
                    <span className="mod-chip">No bundled mods</span>
                  )}
                </div>
              </div>
              <div className="modpack-side">
                <dl>
                  <div>
                    <dt>Version</dt>
                    <dd>{version.label}</dd>
                  </div>
                  <div>
                    <dt>Mods</dt>
                    <dd>{modpack.enabledMods}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{modpack.totalSizeMb} MB</dd>
                  </div>
                  <div>
                    <dt>Channel</dt>
                    <dd>{modpack.channel}</dd>
                  </div>
                </dl>
                <button className="secondary-action" type="button" disabled={active} onClick={() => onSelectModpack(modpack)}>
                  {active ? "Selected" : "Select pack"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
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

function LogsScreen({
  entries,
  onClear
}: {
  entries: LaunchHistoryEntry[];
  onClear: () => void;
}) {
  return (
    <section className="logs-screen" aria-labelledby="logs-title">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Launcher telemetry</p>
          <h1 id="logs-title">Logs</h1>
        </div>
        <button className="icon-label-button" type="button" onClick={onClear} disabled={entries.length === 0}>
          <ListChecks size={18} />
          <span>Clear</span>
        </button>
      </header>

      <div className="log-list">
        {entries.length === 0 ? (
          <div className="empty-state compact">
            <ListChecks size={24} />
            <strong>No launch plans yet</strong>
            <span>Press Play on Home to create a dry-run launch plan and capture its stages here.</span>
          </div>
        ) : (
          entries.map((entry) => (
            <article className={`log-row ${entry.status}`} key={entry.id}>
              <div className="log-status">
                <StatusIcon ok={entry.status === "ready"} />
              </div>
              <div className="log-main">
                <strong>{entry.profileName}</strong>
                <span>{entry.message}</span>
              </div>
              <dl>
                <div>
                  <dt>Session</dt>
                  <dd>{entry.id}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatLogTime(entry.createdAt)}</dd>
                </div>
                <div>
                  <dt>Stages</dt>
                  <dd>{entry.stageCount}</dd>
                </div>
                <div>
                  <dt>Blockers</dt>
                  <dd>{entry.blockerCount}</dd>
                </div>
              </dl>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function formatLogTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function SettingsScreen({
  backgroundAnimation,
  customJavaPath,
  customMinecraftPath,
  status,
  onSaveCustomJavaPath,
  onSaveCustomMinecraftPath,
  onToggleAnimation
}: {
  backgroundAnimation: boolean;
  customJavaPath?: string;
  customMinecraftPath?: string;
  status: string;
  onSaveCustomJavaPath: (path?: string) => void;
  onSaveCustomMinecraftPath: (path?: string) => void;
  onToggleAnimation: () => void;
}) {
  const [javaPath, setJavaPath] = useState(customJavaPath ?? "");
  const [minecraftPath, setMinecraftPath] = useState(customMinecraftPath ?? "");

  useEffect(() => {
    setJavaPath(customJavaPath ?? "");
  }, [customJavaPath]);

  useEffect(() => {
    setMinecraftPath(customMinecraftPath ?? "");
  }, [customMinecraftPath]);

  return (
    <section className="settings-screen" aria-labelledby="settings-title">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Launcher settings</p>
          <h1 id="settings-title">Settings</h1>
        </div>
        <div className="profile-pill">
          <Coffee size={16} />
          <span>{status}</span>
        </div>
      </header>

      <div className="setting-row">
        <div>
          <strong>Background motion</strong>
          <span>{status}</span>
        </div>
        <button className={backgroundAnimation ? "switch active" : "switch"} type="button" onClick={onToggleAnimation}>
          <span />
        </button>
      </div>

      <form
        className="settings-panel"
        onSubmit={(event) => {
          event.preventDefault();
          onSaveCustomJavaPath(javaPath);
        }}
      >
        <div className="settings-panel-header">
          <div>
            <strong>Custom Java runtime</strong>
            <span>Use a specific java.exe when automatic detection misses the right runtime.</span>
          </div>
          <Coffee size={20} />
        </div>
        <label htmlFor="custom-java-path">java.exe path</label>
        <div className="settings-input-row">
          <input
            id="custom-java-path"
            onChange={(event) => setJavaPath(event.target.value)}
            placeholder="C:\\Program Files\\Java\\jdk-21\\bin\\java.exe"
            type="text"
            value={javaPath}
          />
          <button className="secondary-action" type="submit">
            Save
          </button>
          <button className="secondary-action" type="button" onClick={() => onSaveCustomJavaPath(undefined)}>
            Reset
          </button>
        </div>
      </form>

      <form
        className="settings-panel"
        onSubmit={(event) => {
          event.preventDefault();
          onSaveCustomMinecraftPath(minecraftPath);
        }}
      >
        <div className="settings-panel-header">
          <div>
            <strong>Custom Minecraft folder</strong>
            <span>Point Helix to a portable or moved .minecraft folder.</span>
          </div>
          <Folder size={20} />
        </div>
        <label htmlFor="custom-minecraft-path">.minecraft path</label>
        <div className="settings-input-row">
          <input
            id="custom-minecraft-path"
            onChange={(event) => setMinecraftPath(event.target.value)}
            placeholder="C:\\Users\\you\\AppData\\Roaming\\.minecraft"
            type="text"
            value={minecraftPath}
          />
          <button className="secondary-action" type="submit">
            Save
          </button>
          <button className="secondary-action" type="button" onClick={() => onSaveCustomMinecraftPath(undefined)}>
            Reset
          </button>
        </div>
      </form>
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
