"use client";

import { useState } from "react";
import { MoreVertical, Trash2, Copy, FolderOpen, HardDrive } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { tauriCmd } from "@/lib/tauri-commands";
import { deleteServerRecord } from "@/lib/db";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

export function ServerActionMenu({ server }: Props) {
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await tauriCmd.deleteServer(server.id, server.install_path, deleteFiles);
      await deleteServerRecord(server.id);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      setDeleteOpen(false);
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            style={{ color: "var(--text-muted)" }}
          >
            <MoreVertical className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            className="gap-2 opacity-50 cursor-not-allowed"
            disabled
            title="Clone server — coming in Phase 9"
          >
            <Copy className="w-4 h-4" />
            Clone Server
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 opacity-50 cursor-not-allowed"
            disabled
            title="Backup — coming in Phase 6"
          >
            <HardDrive className="w-4 h-4" />
            Backup Now
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 opacity-50 cursor-not-allowed"
            disabled
            title="Open in file explorer — coming in Phase 9"
          >
            <FolderOpen className="w-4 h-4" />
            Open Folder
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2"
            style={{ color: "var(--neon-red)" }}
            onClick={() => {
              setDeleteFiles(false);
              setDeleteOpen(true);
            }}
          >
            <Trash2 className="w-4 h-4" />
            Delete Server
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle style={{ color: "var(--neon-red)" }}>
              Delete &ldquo;{server.name}&rdquo;?
            </DialogTitle>
            <DialogDescription>
              This will remove the server from LokiASAM. Backup archives are
              never deleted.
            </DialogDescription>
          </DialogHeader>

          <label className="flex items-center gap-3 cursor-pointer select-none mt-1">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(e) => setDeleteFiles(e.target.checked)}
              className="w-4 h-4 accent-red-500"
            />
            <span className="text-sm" style={{ color: "var(--text-primary)" }}>
              Also delete server files on disk
              <span
                className="block text-xs mt-0.5"
                style={{ color: "var(--text-muted)" }}
              >
                {server.install_path}
              </span>
            </span>
          </label>

          <DialogFooter className="gap-2 mt-2">
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              disabled={deleting}
              onClick={handleDelete}
              style={{
                background: "rgba(255,0,85,0.15)",
                borderColor: "var(--neon-red)",
                color: "var(--neon-red)",
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
