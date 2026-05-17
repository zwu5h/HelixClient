import {
  BadgeCheck,
  Boxes,
  Gauge,
  Home,
  ListVideo,
  Palette,
  Settings,
  Sparkles,
  UserRound
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
};

export const navItems: NavItem[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "versions", label: "Versions", icon: BadgeCheck },
  { id: "modpacks", label: "Modpacks", icon: Boxes },
  { id: "hud", label: "HUD", icon: ListVideo },
  { id: "cosmetics", label: "Cosmetics", icon: Sparkles },
  { id: "performance", label: "Performance", icon: Gauge },
  { id: "logs", label: "Logs", icon: Palette },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "accounts", label: "Accounts", icon: UserRound }
];

export const launchProfile = {
  name: "Helix 1.8.9 PvP",
  version: "1.8.9 Forge",
  modpack: "1.8.9 PvP",
  status: "Ready for launcher foundation checks",
  account: "No Microsoft account connected"
};

