import { invoke } from "@tauri-apps/api/core";

export type MinecraftPathStatus = {
  path?: string;
  exists: boolean;
  versionsDirExists: boolean;
  modsDirExists: boolean;
  launcherProfilesExists: boolean;
};

export type JavaInstallation = {
  path: string;
  version?: string;
  majorVersion?: number;
  source: string;
  supports189: boolean;
  supportsModern: boolean;
};

export type JavaDetection = {
  installations: JavaInstallation[];
  java8?: JavaInstallation;
  modern?: JavaInstallation;
  custom?: JavaInstallation;
};

export type SystemDetection = {
  minecraft: MinecraftPathStatus;
  java: JavaDetection;
  message: string;
};

export async function detectSystemPaths(): Promise<SystemDetection> {
  return await invoke<SystemDetection>("detect_system_paths");
}
