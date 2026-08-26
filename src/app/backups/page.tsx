"use client";

import { Archive } from "lucide-react";
import { ServerScopedTabPage } from "@/components/shared/ServerScopedTabPage";
import { BackupsTab } from "@/components/server/tabs/BackupsTab";

export default function BackupsPage() {
  return (
    <ServerScopedTabPage
      icon={Archive}
      title="Backups"
      description="Browse and restore saved backups for your ARK servers."
      emptyStateDescription="Create a server to start managing backups."
      contentClassName="overflow-y-auto"
      TabComponent={BackupsTab}
    />
  );
}
