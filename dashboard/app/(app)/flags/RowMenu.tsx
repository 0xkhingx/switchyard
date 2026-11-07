"use client";

import { ArchiveIcon, ArrowLeftIcon, MoreHorizIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import styles from "./flags.module.css";

// Three-dot row menu. Only what v1 supports: Open, Archive.
export function RowMenu({
  flagKey,
  onOpen,
  onArchive,
}: {
  flagKey: string;
  onOpen: () => void;
  onArchive: () => void;
}) {
  return (
    // The row itself is clickable; keep menu clicks (portal included, since
    // React bubbles through portals) from also opening the flag.
    <div className={styles.menuWrap} onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger className={styles.dotsButton} aria-label={`Actions for ${flagKey}`}>
          <MoreHorizIcon size={20} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onOpen}>
            <ArrowLeftIcon className="rotate-180" />
            Open
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onArchive}>
            <ArchiveIcon />
            Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
