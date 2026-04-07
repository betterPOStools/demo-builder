import type { StateCreator } from "zustand";
import type {
  DeployStatus,
  DeployResult,
  DeployStats,
  PendingImageTransfer,
  SavedConnection,
} from "@/lib/types";

export interface DeploySlice {
  // Connection
  savedConnections: SavedConnection[];
  activeConnectionId: string | null;
  setSavedConnections: (connections: SavedConnection[]) => void;
  setActiveConnection: (id: string | null) => void;

  // Staged SQL
  generatedSql: string | null;
  deployStats: DeployStats | null;
  pendingImages: PendingImageTransfer[];
  setStagedDeploy: (sql: string, stats: DeployStats, images: PendingImageTransfer[]) => void;
  clearStagedDeploy: () => void;

  // Deploy status
  deployStatus: DeployStatus;
  deployResult: DeployResult | null;
  setDeployStatus: (status: DeployStatus) => void;
  setDeployResult: (result: DeployResult) => void;
  resetDeploy: () => void;
}

export const createDeploySlice: StateCreator<DeploySlice> = (set) => ({
  savedConnections: [],
  activeConnectionId: null,
  setSavedConnections: (connections) => set({ savedConnections: connections }),
  setActiveConnection: (id) => set({ activeConnectionId: id }),

  generatedSql: null,
  deployStats: null,
  pendingImages: [],
  setStagedDeploy: (sql, stats, images) =>
    set({ generatedSql: sql, deployStats: stats, pendingImages: images }),
  clearStagedDeploy: () =>
    set({ generatedSql: null, deployStats: null, pendingImages: [] }),

  deployStatus: "idle",
  deployResult: null,
  setDeployStatus: (status) => set({ deployStatus: status }),
  setDeployResult: (result) => set({ deployResult: result, deployStatus: "done" }),
  resetDeploy: () =>
    set({ deployStatus: "idle", deployResult: null }),
});
