"use client";

import { RconConsole } from "@/components/server/rcon/RconConsole";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

export function RconTab({ server }: Props) {
  return <RconConsole server={server} />;
}
