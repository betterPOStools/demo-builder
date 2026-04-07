// Deploy-related types

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  upload_server_url: string | null;
  created_at: string;
}

export interface DeployTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  upload_server_url?: string;
}

export interface DeployResult {
  ok: boolean;
  rows_affected: number;
  error: string | null;
  timestamp: string;
  images_pushed: number;
  images_failed: number;
}

export interface StagedSession {
  id: string;
  session_id: string;
  sql: string;
  stats: DeployStats;
  pending_images: PendingImageTransfer[];
  created_at: string;
}

export interface DeployStats {
  categories: number;
  groups: number;
  menu_items: number;
  modifier_templates: number;
  pending_image_transfers: number;
}

export interface PendingImageTransfer {
  type: "item" | "group";
  name: string;
  entity_id: string;
  image_url: string;
  dest_path: string;
}

export type DeployStatus = "idle" | "queued" | "executing" | "done" | "failed";
