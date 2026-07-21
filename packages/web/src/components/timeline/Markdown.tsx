"use client";

import { MessageResponse } from "@/components/ai-elements/message";

export function Markdown({ md }: { md: string }) {
  return (
    <div className="markdown-body wrap-break-word text-sm leading-relaxed">
      <MessageResponse>{md}</MessageResponse>
    </div>
  );
}
