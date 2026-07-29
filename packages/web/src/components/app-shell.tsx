"use client";

import { HomeIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FalconMark } from "@/components/falcon-mark";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { WorkspaceNav } from "@/components/workspace-nav";

const HOME_HREF = "/dashboard/";

/**
 * Any route that's "inside" a session (timeline, its git panel, or an
 * unmanaged session) — as opposed to the session list. Used below to decide
 * whether the content area gets full-width, scroll-managed-internally
 * treatment.
 */
export function isSessionRoute(pathname: string): boolean {
  return pathname.startsWith("/dashboard/session/");
}

function pageTitle(pathname: string): string {
  if (pathname === "/dashboard/") return "Home";
  if (pathname.includes("/git/")) return "Files changed";
  if (pathname.includes("/files/")) return "Repo files";
  if (pathname.startsWith("/dashboard/session/")) return "Session";
  return "Falcon";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const title = pageTitle(pathname);
  const isHome = pathname === HOME_HREF;
  const isSessionDetailRoute = isSessionRoute(pathname) && !pathname.includes("/git/");

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="lg" tooltip="Falcon">
                <Link href="/dashboard/">
                  {/*
                   * `shrink-0` + `aspect-square` keep the logo box a full
                   * 32×32 when the collapsed icon rail squeezes the button to
                   * `size-8 p-0` (sidebar.tsx's lg size variant) — without it
                   * flexbox squishes the logo against the still-visible label
                   * (the broken-header bug). The label hides in icon mode
                   * instead. Same shape as shadcn's TeamSwitcher logo box.
                   */}
                  <FalconMark className="aspect-square size-8 shrink-0" />
                  <span className="truncate font-semibold group-data-[collapsible=icon]:hidden">
                    Falcon
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isHome} tooltip="Home">
                    <Link href={HOME_HREF} aria-current={isHome ? "page" : undefined}>
                      <HomeIcon aria-hidden="true" />
                      <span>Home</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <WorkspaceNav />
        </SidebarContent>
        <SidebarFooter>
          <NavUser />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4 sm:px-6">
          <SidebarTrigger />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
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
