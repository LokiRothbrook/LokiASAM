"use client";

import { ScrollText } from "lucide-react";
import { ServerScopedTabPage } from "@/components/shared/ServerScopedTabPage";
import { LogsTab } from "@/components/server/tabs/LogsTab";

export default function LogsPage() {
  return (
    <ServerScopedTabPage
      icon={ScrollText}
      title="Logs"
      description="Browse server logs, crash reports, and chat history."
      emptyStateDescription="Create a server to start viewing logs."
      contentClassName="overflow-hidden"
      TabComponent={LogsTab}
    />
  );
}
