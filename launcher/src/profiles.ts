export type LaunchProfile = {
  id: string;
  name: string;
  versionId: string;
  modpackId: string;
  loader: "Forge" | "Fabric" | "Vanilla";
  minecraftVersion: string;
  javaTarget: "Java 8" | "Java 21+";
  memoryMb: number;
  resolution: string;
  status: string;
};

export type VersionOption = {
  id: string;
  label: string;
  minecraftVersion: string;
  loader: LaunchProfile["loader"];
  javaTarget: LaunchProfile["javaTarget"];
  status: string;
};

export type ModpackOption = {
  id: string;
  name: string;
  versionId: string;
  summary: string;
  enabledMods: number;
  status: string;
};

export const versions: VersionOption[] = [
  {
    id: "1.8.9-forge",
    label: "1.8.9 Forge",
    minecraftVersion: "1.8.9",
    loader: "Forge",
    javaTarget: "Java 8",
    status: "PvP baseline"
  },
  {
    id: "1.21.1-fabric",
    label: "1.21.1 Fabric",
    minecraftVersion: "1.21.1",
    loader: "Fabric",
    javaTarget: "Java 21+",
    status: "Modern baseline"
  },
  {
    id: "1.21.1-vanilla",
    label: "1.21.1 Vanilla",
    minecraftVersion: "1.21.1",
    loader: "Vanilla",
    javaTarget: "Java 21+",
    status: "Clean profile"
  }
];

export const modpacks: ModpackOption[] = [
  {
    id: "pvp-1-8-9",
    name: "1.8.9 PvP",
    versionId: "1.8.9-forge",
    summary: "Optimized client-side PvP pack with HUD, FPS and quality-of-life modules.",
    enabledMods: 18,
    status: "Ready for manifest wiring"
  },
  {
    id: "modern-essentials",
    name: "Modern Essentials",
    versionId: "1.21.1-fabric",
    summary: "A lightweight modern profile for performance, HUD and clean usability.",
    enabledMods: 12,
    status: "Manifest planned"
  },
  {
    id: "vanilla-clean",
    name: "Vanilla Clean",
    versionId: "1.21.1-vanilla",
    summary: "No mod loader, no modpack. Useful for testing official asset and version handling.",
    enabledMods: 0,
    status: "Available"
  }
];

export const launchProfiles: LaunchProfile[] = [
  {
    id: "forge-1-8-9-pvp",
    name: "Helix 1.8.9 PvP",
    versionId: "1.8.9-forge",
    modpackId: "pvp-1-8-9",
    loader: "Forge",
    minecraftVersion: "1.8.9",
    javaTarget: "Java 8",
    memoryMb: 2048,
    resolution: "1280x720",
    status: "Ready for launcher foundation checks"
  },
  {
    id: "fabric-modern-essentials",
    name: "Helix Modern Essentials",
    versionId: "1.21.1-fabric",
    modpackId: "modern-essentials",
    loader: "Fabric",
    minecraftVersion: "1.21.1",
    javaTarget: "Java 21+",
    memoryMb: 4096,
    resolution: "1600x900",
    status: "Prepared for modern launch pipeline"
  },
  {
    id: "vanilla-clean",
    name: "Helix Vanilla Clean",
    versionId: "1.21.1-vanilla",
    modpackId: "vanilla-clean",
    loader: "Vanilla",
    minecraftVersion: "1.21.1",
    javaTarget: "Java 21+",
    memoryMb: 3072,
    resolution: "1600x900",
    status: "Clean launch profile"
  }
];

export function getProfile(profileId: string): LaunchProfile {
  return launchProfiles.find((profile) => profile.id === profileId) ?? launchProfiles[0];
}

export function getVersion(versionId: string): VersionOption {
  return versions.find((version) => version.id === versionId) ?? versions[0];
}

export function getModpack(modpackId: string): ModpackOption {
  return modpacks.find((modpack) => modpack.id === modpackId) ?? modpacks[0];
}
