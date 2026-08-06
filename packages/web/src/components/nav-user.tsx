"use client";

import { ChevronsUpDownIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SettingsDialog } from "@/components/settings-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { listDeviceSessions } from "@/lib/api";
import { logout } from "@/lib/logout";
import { getAccountId, getToken } from "@/lib/session";

/** Two-letter avatar fallback — the email's local part when we have one,
 * else the account id's prefix for the rare account with none on file yet. */
function accountInitials(email: string | null, accountId: string | null): string {
  if (email) return email.split("@")[0]?.slice(0, 2).toUpperCase() || "?";
  if (!accountId) return "?";
  return accountId.slice(0, 2).toUpperCase();
}

/**
 * The JWT carries no email claim by design (`sub`/`sid`/`ct` only) — email
 * instead comes from `GET /v1/auth/sessions` (`listDeviceSessions`).
 * Falls back to the account id's prefix before the fetch resolves or when
 * no email is on file.
 */
export function NavUser() {
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  // Read lazily per render — the footer only exists inside the protected
  // route group, so a token is present by the time this mounts.
  const accountId = getAccountId();
  const accountLabel = email ?? (accountId ? `Account ${accountId.slice(0, 8)}` : "Not signed in");

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) return;
    listDeviceSessions(token)
      .then((result) => {
        if (cancelled) return;
        setEmail(result.email);
        setImage(result.image);
      })
      .catch(() => {
        // Best-effort only — falls back to the account-id label above.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
                  {image && <AvatarImage src={image} alt="" />}
                  <AvatarFallback className="rounded-lg">
                    {accountInitials(email, accountId)}
                  </AvatarFallback>
                </Avatar>
                <span className="flex-1 truncate text-left text-sm font-medium">
                  {accountLabel}
                </span>
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
                  <Avatar className="size-8 rounded-lg grayscale">
                    {image && <AvatarImage src={image} alt="" />}
                    <AvatarFallback className="rounded-lg">
                      {accountInitials(email, accountId)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate text-left text-sm font-medium">
                    {accountLabel}
                  </span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                <SettingsIcon />
                Settings
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
