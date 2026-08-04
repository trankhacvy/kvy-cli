"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const INSTALL_OPTIONS = [
  {
    id: "native",
    label: "Native (Recommended)",
    command: "curl -fsSL https://kvy-cli.tkvy.dev/install.sh | sh",
  },
  {
    id: "brew",
    label: "Homebrew",
    command: "brew install kvy",
  },
  {
    id: "npm",
    label: "npm",
    command: "npm install -g @vibe-oss/kvy",
  },
] as const;

export function InstallTabs({ className }: { className?: string }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copy(id: string, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // clipboard unavailable — command text stays selectable
    }
  }

  return (
    <Tabs defaultValue="native" className={cn("w-full", className)}>
      <TabsList variant="line" className="w-full">
        {INSTALL_OPTIONS.map((opt) => (
          <TabsTrigger key={opt.id} value={opt.id} className="flex-1">
            {opt.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {INSTALL_OPTIONS.map((opt) => (
        <TabsContent key={opt.id} value={opt.id}>
          <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2.5">
            <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm">{opt.command}</code>
            <button
              type="button"
              aria-label={`Copy: ${opt.command}`}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => copy(opt.id, opt.command)}
            >
              {copiedId === opt.id ? (
                <Check className="size-4 text-primary" />
              ) : (
                <Copy className="size-4" />
              )}
            </button>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}
