import {
  BadgeCheck,
  Boxes,
  Gauge,
  Home,
  ListVideo,
  Palette,
  SlidersHorizontal,
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
  { id: "profiles", label: "Profiles", icon: SlidersHorizontal },
  { id: "versions", label: "Versions", icon: BadgeCheck },
  { id: "modpacks", label: "Modpacks", icon: Boxes },
  { id: "hud", label: "HUD", icon: ListVideo },
  { id: "cosmetics", label: "Cosmetics", icon: Sparkles },
  { id: "performance", label: "Performance", icon: Gauge },
  { id: "logs", label: "Logs", icon: Palette },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "accounts", label: "Accounts", icon: UserRound }
];
