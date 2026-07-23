"use client";

import { HomeIcon, type LucideIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavUser } from "@/components/nav-user";
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
                  {/*
                   * `shrink-0` + `aspect-square` keep the logo box a full
                   * 32×32 when the collapsed icon rail squeezes the button to
                   * `size-8 p-0` (sidebar.tsx's lg size variant) — without it
                   * flexbox squishes the logo against the still-visible label
                   * (the broken-header bug). The label hides in icon mode
                   * instead. Same shape as shadcn's TeamSwitcher logo box.
                   */}
                  <span className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    F
                  </span>
                  <span className="truncate font-semibold group-data-[collapsible=icon]:hidden">
                    Falcon
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <NavigationGroup label="Workspace" items={workspaceNav} pathname={pathname} />
        </SidebarContent>
        <SidebarFooter>
          <NavUser />
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
