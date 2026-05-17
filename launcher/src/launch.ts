import type { AccountSummary } from "./auth";
import type { LaunchProfile, ModpackOption, VersionOption } from "./profiles";
import type { SystemDetection } from "./system";

export type LaunchCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type LaunchReadiness = {
  ready: boolean;
  message: string;
  checks: LaunchCheck[];
};

export function evaluateLaunchReadiness({
  account,
  modpack,
  profile,
  system,
  version
}: {
  account?: AccountSummary;
  modpack: ModpackOption;
  profile: LaunchProfile;
  system?: SystemDetection;
  version: VersionOption;
}): LaunchReadiness {
  const javaReady =
    profile.javaTarget === "Java 8" ? Boolean(system?.java.java8) : Boolean(system?.java.modern);
  const checks: LaunchCheck[] = [
    {
      id: "account",
      label: "Microsoft account",
      ok: Boolean(account),
      detail: account ? `${account.username} selected` : "Connect a Microsoft account first"
    },
    {
      id: "ownership",
      label: "Minecraft Java ownership",
      ok: Boolean(account?.ownsJava),
      detail: account?.ownsJava ? "Java entitlement validated" : "Ownership is not validated yet"
    },
    {
      id: "minecraft-folder",
      label: "Minecraft folder",
      ok: Boolean(system?.minecraft.exists),
      detail: system?.minecraft.path ?? "Default .minecraft folder was not found"
    },
    {
      id: "java",
      label: profile.javaTarget,
      ok: javaReady,
      detail: javaReady ? `${profile.javaTarget} runtime found` : `${profile.javaTarget} runtime missing`
    },
    {
      id: "profile-version",
      label: "Profile version",
      ok: profile.versionId === version.id && modpack.versionId === version.id,
      detail:
        profile.versionId === version.id && modpack.versionId === version.id
          ? `${version.label} matches selected pack`
          : "Profile, version and modpack IDs do not match"
    },
    {
      id: "manifest",
      label: "Modpack manifest",
      ok: modpack.mods.every((mod) => mod.id && mod.name && mod.version),
      detail:
        modpack.mods.length === 0
          ? "Vanilla profile has no mod manifest entries"
          : `${modpack.mods.filter((mod) => mod.required).length} required mods, ${modpack.mods.length} listed`
    }
  ];
  const firstBlocker = checks.find((check) => !check.ok);

  return {
    checks,
    ready: !firstBlocker,
    message: firstBlocker ? firstBlocker.detail : "Preflight passed. Ready for launch pipeline."
  };
}
