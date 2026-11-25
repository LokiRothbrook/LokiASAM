"use client";

/**
 * WipeWildDinosDialog — confirmation for DestroyWildDinos. Used by the RCON
 * console's quick action and the Overview tab, so both warn players in chat
 * first and neither wipes the map on a single misclick.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Skull } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { tauriCmd } from "@/lib/tauri-commands";

const WARNING = "ServerChat Wild dinos are being wiped — expect some lag!";

export function WipeWildDinosDialog({
  serverId,
  open,
  onOpenChange,
}: {
  serverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [wiping, setWiping] = useState(false);

  const wipe = async () => {
    setWiping(true);
    try {
      await tauriCmd.rconSend(serverId, WARNING);
      await tauriCmd.rconSend(serverId, "DestroyWildDinos");
      toast.success("Wild dinos wiped — they'll respawn over the next few minutes.");
      onOpenChange(false);
    } catch (e) {
      toast.error(`Wipe failed: ${e}`);
    } finally {
      setWiping(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!wiping) onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Skull className="w-4 h-4" style={{ color: "var(--neon-orange)" }} /> Wipe all wild dinos?
          </DialogTitle>
          <DialogDescription>
            Every wild (untamed) creature on the map is destroyed and respawns fresh. Tamed dinos aren&apos;t
            affected. Players get a chat warning first, and the server may lag for a few seconds.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={wiping}>Cancel</Button>
          <Button size="sm" onClick={wipe} disabled={wiping}
            style={{ background: "rgba(var(--neon-orange-rgb),0.15)", border: "1px solid rgba(var(--neon-orange-rgb),0.4)", color: "var(--neon-orange)" }}>
            {wiping ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Skull className="w-3.5 h-3.5 mr-1.5" />}
            Wipe wild dinos
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
