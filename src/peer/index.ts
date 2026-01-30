export type {
  PeerInfo,
  StoredPeerInfo,
  PeerState,
  PeerManagerConfig,
  PeerManagerEvents,
} from "./types";

export { PeerManager, type VaultAdoptionRequest } from "./peer-manager";

// Peer groups
export {
  PeerGroupManager,
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP,
  DEFAULT_SYNC_POLICY,
  type PeerGroup,
  type GroupSyncPolicy,
  type PeerGroupEvents,
} from "./groups";
