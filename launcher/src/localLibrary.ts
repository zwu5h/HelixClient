import { invoke } from "@tauri-apps/api/core";
import type { LaunchProfile, ModpackOption, VersionOption } from "./profiles";

export type LocalLibraryStatus = {
  rootDir: string;
  createdDirs: string[];
  writtenFiles: string[];
  message: string;
};

export async function prepareLocalLibrary({
  modpacks,
  profiles,
  versions
}: {
  modpacks: ModpackOption[];
  profiles: LaunchProfile[];
  versions: VersionOption[];
}): Promise<LocalLibraryStatus> {
  return await invoke<LocalLibraryStatus>("prepare_local_library", {
    request: {
      modpacks,
      profiles,
      versions
    }
  });
}
