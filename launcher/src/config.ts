import { invoke } from "@tauri-apps/api/core";

export type LauncherConfig = {
  selectedProfileId: string;
  selectedVersionId: string;
  selectedModpackId: string;
  accentColor: string;
  backgroundAnimation: boolean;
  customJavaPath?: string;
};

export const defaultConfig: LauncherConfig = {
  selectedProfileId: "forge-1-8-9-pvp",
  selectedVersionId: "1.8.9 Forge",
  selectedModpackId: "1.8.9 PvP",
  accentColor: "#66d9ff",
  backgroundAnimation: true,
  customJavaPath: undefined
};

const fallbackKey = "helix-launcher-config";

export async function loadLauncherConfig(): Promise<LauncherConfig> {
  try {
    return await invoke<LauncherConfig>("load_launcher_config");
  } catch {
    const stored = window.localStorage.getItem(fallbackKey);
    return stored ? { ...defaultConfig, ...JSON.parse(stored) } : defaultConfig;
  }
}

export async function saveLauncherConfig(config: LauncherConfig): Promise<void> {
  try {
    await invoke("save_launcher_config", { config });
  } catch {
    window.localStorage.setItem(fallbackKey, JSON.stringify(config));
  }
}
