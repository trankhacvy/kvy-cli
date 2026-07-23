"use client";

import { ChevronsUpDownIcon, LogOutIcon, SettingsIcon, ShieldCheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SettingsDialog } from "@/components/settings-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { SIGNIN_PATH } from "@/features/auth";
import { logout } from "@/lib/logout";
import { getAccountId } from "@/lib/session";

/** Two-letter avatar fallback from the account id (key-based accounts have no
 * name/avatar — design §5.2 — so the id's prefix is all there is to show). */
function accountInitials(accountId: string | null): string {
  if (!accountId) return "?";
  return accountId.slice(0, 2).toUpperCase();
}

/**
 * The sidebar footer's account menu (adapted from shadcn's `nav-user` block
 * to this codebase: lucide icons, key-based account identity from the stored
 * JWT via `getAccountId()` — there's no name/email/avatar to show). The popup
 * opens top-center above the trigger. "Settings" opens `SettingsDialog`;
 * "Log out" runs `lib/logout.ts`'s teardown (wipe key material → disconnect
 * the socket → clear the token) and lands on `/signin/`.
 */
export function NavUser() {
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Read lazily per render — the footer only exists inside the protected
  // route group, so a token is present by the time this mounts.
  const accountId = getAccountId();
  const accountLabel = accountId ? `Account ${accountId.slice(0, 8)}` : "Not signed in";

  async function handleLogout() {
    await logout();
    router.replace(SIGNIN_PATH);
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                tooltip={accountLabel}
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">
                    {accountInitials(accountId)}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{accountLabel}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    End-to-end encrypted
                  </span>
                </div>
                <ChevronsUpDownIcon className="ml-auto size-4" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
              side="top"
              align="center"
              sideOffset={4}
            >
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg">
                      {accountInitials(accountId)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{accountLabel}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      End-to-end encrypted
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                <SettingsIcon />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <ShieldCheckIcon />
                End-to-end encrypted
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void handleLogout()}>
                <LogOutIcon />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
