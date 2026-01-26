export { PeerVaultSettingsTab } from "./settings-tab";
export { PeerVaultStatusModal } from "./status-modal";
export { PairingModal, type PairingTab } from "./pairing-modal";
export { showConfirm, type ConfirmOptions } from "./confirm-modal";
export {
  MergeDetailModal,
  MergeHistoryModal,
  recordMerge,
  getRecentMerges,
  clearMergeHistory,
  type MergeInfo,
} from "./merge-notification";
export {
  ConnectionStatusManager,
  ConnectionStatusModal,
  recordSyncError,
  getRecentErrors,
  clearErrors,
  updateSyncProgress,
  getSyncProgress,
  type SyncProgress,
  type SyncError,
} from "./connection-status";
export { FileHistoryModal, type FileVersion } from "./file-history-modal";
export { SelectiveSyncModal } from "./selective-sync-modal";
export { EncryptionModal } from "./encryption-modal";
export { ConflictModal } from "./conflict-modal";
export { GroupModal, GroupPeersModal } from "./group-modal";
export { STATUS_ICONS, getPeerStateIcon, getStatusLabel } from "./status-icons";
