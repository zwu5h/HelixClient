import { invoke } from "@tauri-apps/api/core";
import type { LaunchProfile, ModpackOption, VersionOption } from "./profiles";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export type LocalLibraryStatus = {
  rootDir: string;
  exists: boolean;
  indexExists: boolean;
  profileCount: number;
  versionCount: number;
  modpackCount: number;
  manifestCount: number;
  missingDirs: string[];
  createdDirs: string[];
  writtenFiles: string[];
  message: string;
};

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function inspectLocalLibrary(): Promise<LocalLibraryStatus> {
  if (!isDesktopRuntime()) {
    return {
      rootDir: "Tauri app data directory",
      exists: false,
      indexExists: false,
      profileCount: 0,
      versionCount: 0,
      modpackCount: 0,
      manifestCount: 0,
      missingDirs: [],
      createdDirs: [],
      writtenFiles: [],
      message: "Desktop local library requires Tauri."
    };
  }

  return await invoke<LocalLibraryStatus>("inspect_local_library");
}

export async function prepareLocalLibrary({
  modpacks,
  profiles,
  versions
}: {
  modpacks: ModpackOption[];
  profiles: LaunchProfile[];
  versions: VersionOption[];
}): Promise<LocalLibraryStatus> {
  if (!isDesktopRuntime()) {
    throw new Error("Desktop local library requires Tauri.");
  }

  return await invoke<LocalLibraryStatus>("prepare_local_library", {
    request: {
      modpacks,
      profiles,
      versions
    }
  });
}
