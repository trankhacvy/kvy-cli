import {
  BellIcon,
  BotIcon,
  CreditCardIcon,
  GitBranchIcon,
  LifeBuoyIcon,
  type LucideIcon,
  MonitorIcon,
  PaletteIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { MachinesSettingsScreen } from "@/features/machine-settings";
import { ProvidersSettingsScreen } from "@/features/provider-accounts";
import { AgentSection } from "./components/AgentSection";
import { AppearanceSection } from "./components/AppearanceSection";
import { GitSection } from "./components/GitSection";
import { NotificationsSection } from "./components/NotificationsSection";
import { RecoverySection } from "./components/RecoverySection";
import { SupportSection } from "./components/SupportSection";

export type SettingsSectionId =
  | "agent"
  | "appearance"
  | "git"
  | "providers"
  | "machines"
  | "notifications"
  | "recovery"
  | "support";

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  /** The section's content, rendered inside the settings dialog's desktop
   * pane or the mobile sheet's drill-in detail view. */
  Content: React.ComponentType;
}

/**
 * The settings catalog — the same eight entries the sidebar's Settings group
 * used to list, now living in the settings dialog
 * (`components/settings-dialog.tsx`) instead of per-route pages (the
 * `/settings/*` routes are gone). Each entry's `Content` is the real
 * settings UI moved out of its deleted route, verbatim.
 */
export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: "agent", label: "Agent", icon: BotIcon, Content: AgentSection },
  { id: "appearance", label: "Appearance", icon: PaletteIcon, Content: AppearanceSection },
  { id: "git", label: "Git", icon: GitBranchIcon, Content: GitSection },
  { id: "providers", label: "Providers", icon: CreditCardIcon, Content: ProvidersSettingsScreen },
  { id: "machines", label: "Machines", icon: MonitorIcon, Content: MachinesSettingsScreen },
  {
    id: "notifications",
    label: "Notifications",
    icon: BellIcon,
    Content: NotificationsSection,
  },
  { id: "recovery", label: "Recovery", icon: ShieldCheckIcon, Content: RecoverySection },
  { id: "support", label: "Support", icon: LifeBuoyIcon, Content: SupportSection },
];
