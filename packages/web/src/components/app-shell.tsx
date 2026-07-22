"use client";

import {
  BellIcon,
  BotIcon,
  GitBranchIcon,
  HomeIcon,
  LifeBuoyIcon,
  type LucideIcon,
  PaletteIcon,
  PlusIcon,
  ShieldCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

type NavItem = { href: string; label: string; icon: LucideIcon };

const workspaceNav: NavItem[] = [
  { href: "/", label: "Sessions", icon: HomeIcon },
  { href: "/session/new/", label: "New session", icon: PlusIcon },
];

const settingsNav: NavItem[] = [
  { href: "/settings/agent/", label: "Agent", icon: BotIcon },
  { href: "/settings/appearance/", label: "Appearance", icon: PaletteIcon },
  { href: "/settings/git/", label: "Git", icon: GitBranchIcon },
  { href: "/settings/notifications/", label: "Notifications", icon: BellIcon },
  { href: "/settings/recovery/", label: "Recovery", icon: ShieldCheckIcon },
  { href: "/settings/support/", label: "Support", icon: LifeBuoyIcon },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href);
}

/**
 * Any route that's "inside" a session (timeline, its git panel, or an
 * unmanaged session) — as opposed to the session list or the new-session
 * wizard. Collapsing the nav on these routes fully hides it (see
 * `sidebarCollapsible` below) rather than shrinking to an icon rail, so the
 * session content gets the full width (competitive-notes-omnara.md #20).
 */
export function isSessionRoute(pathname: string): boolean {
  return pathname.startsWith("/session/") && pathname !== "/session/new/";
}

/**
 * `"offcanvas"` fully removes the sidebar (width 0) when collapsed, giving a
 * genuinely full-width view; `"icon"` (the default everywhere else) leaves a
 * narrow icon-only rail so the rest of the app keeps quick nav access.
 */
export function sidebarCollapsible(pathname: string): "icon" | "offcanvas" {
  return isSessionRoute(pathname) ? "offcanvas" : "icon";
}

function pageTitle(pathname: string): string {
  if (pathname === "/") return "Sessions";
  if (pathname === "/session/new/") return "New session";
  if (pathname.startsWith("/settings/")) return "Settings";
  if (pathname.includes("/git/")) return "Files changed";
  if (pathname.includes("/files/")) return "Repo files";
  if (pathname.startsWith("/session/")) return "Session";
  return "Falcon";
}

function NavigationGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: NavItem[];
  pathname: string;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                asChild
                isActive={isActive(pathname, item.href)}
                tooltip={item.label}
              >
                <Link
                  href={item.href}
                  aria-current={isActive(pathname, item.href) ? "page" : undefined}
                >
                  <item.icon aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const title = pageTitle(pathname);
  const isSessionDetailRoute = isSessionRoute(pathname) && !pathname.includes("/git/");

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible={sidebarCollapsible(pathname)}>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="lg" tooltip="Falcon">
                <Link href="/">
                  <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    F
                  </span>
                  <span className="font-semibold">Falcon</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <NavigationGroup label="Workspace" items={workspaceNav} pathname={pathname} />
          <NavigationGroup label="Settings" items={settingsNav} pathname={pathname} />
        </SidebarContent>
        <SidebarFooter>
          <p className="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            End-to-end encrypted
          </p>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4 sm:px-6">
          <SidebarTrigger />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
          {pathname !== "/session/new/" && (
            <Button asChild size="sm" className="hidden sm:inline-flex">
              <Link href="/session/new/">
                <PlusIcon data-icon="inline-start" />
                New session
              </Link>
            </Button>
          )}
        </header>
        <div
          className={
            isSessionDetailRoute ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-auto"
          }
        >
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
