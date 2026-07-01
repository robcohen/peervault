//! Loro-based Document Store
//!
//! Implements the DocStore trait using Loro CRDTs.
//! Matches the TypeScript implementation's data model:
//! - LoroTree "files" for file structure
//! - LoroText for text content (stored separately)
//! - Binary files store blob hash references

use loro::{LoroDoc, LoroTree, LoroValue, ExportMode, TreeID};
use std::collections::HashMap;
use std::sync::RwLock;
use web_time::{SystemTime, UNIX_EPOCH};

use super::{DocStore, FileNode, FileType, Hash, StoreError, StoreResult};

/// Reject paths that could escape the vault directory when written to disk.
///
/// Paths originate from peer CRDT data and are untrusted. We disallow absolute
/// paths, parent traversal (`..`) and embedded NUL bytes. Empty paths are also
/// rejected (callers expect at least one path component).
fn validate_path(path: &str) -> StoreResult<()> {
    if path.is_empty() || path.starts_with('/') || path.starts_with('\\') {
        return Err(StoreError::InvalidPath(path.to_string()));
    }
    // Windows drive-absolute (`C:\x`, `C:x`) — reject any first component with a colon.
    for (i, component) in path.split(|c| c == '/' || c == '\\').enumerate() {
        if component == ".." || component.contains('\0') {
            return Err(StoreError::InvalidPath(path.to_string()));
        }
        if i == 0 && component.len() >= 2 && component.as_bytes()[1] == b':' {
            return Err(StoreError::InvalidPath(path.to_string()));
        }
    }
    Ok(())
}

/// Is a single tree-node `name` safe to use as one path component?
///
/// Node names come from peer CRDT data and are untrusted. A name must be a
/// single component: it may not be empty, `.`/`..`, contain a path separator,
/// a NUL byte, or a drive-letter colon. This is the egress-side guard that
/// stops malicious imported nodes from escaping the vault when their paths are
/// later written to disk by the host.
fn is_safe_component(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
        && !name.contains(':')
}

/// Tree container name (matches TypeScript)
const TREE_NAME: &str = "files";

/// Meta container name
const META_NAME: &str = "meta";

/// Loro-based document store
pub struct LoroStore {
    /// The Loro document
    doc: RwLock<LoroDoc>,
    /// Vault ID
    vault_id: [u8; 32],
    /// Path to TreeID cache for O(1) lookups
    path_cache: RwLock<HashMap<String, TreeID>>,
}

impl LoroStore {
    /// Create a new empty store
    pub fn new(vault_id: [u8; 32]) -> Self {
        let doc = LoroDoc::new();

        // Initialize the meta map with vault ID
        let meta = doc.get_map(META_NAME);
        meta.insert("vaultId", hex::encode(vault_id)).ok();

        Self {
            doc: RwLock::new(doc),
            vault_id,
            path_cache: RwLock::new(HashMap::new()),
        }
    }

    /// Create from existing snapshot
    pub fn from_snapshot(vault_id: [u8; 32], snapshot: &[u8]) -> StoreResult<Self> {
        let doc = LoroDoc::new();
        doc.import(snapshot)
            .map_err(|e| StoreError::Loro(e.to_string()))?;

        Ok(Self {
            doc: RwLock::new(doc),
            vault_id,
            path_cache: RwLock::new(HashMap::new()),
        })
    }

    /// Get the Loro document (for advanced operations)
    pub fn doc(&self) -> std::sync::RwLockReadGuard<'_, LoroDoc> {
        self.doc.read().unwrap()
    }

    /// Get the file tree
    fn tree(&self) -> LoroTree {
        self.doc.read().unwrap().get_tree(TREE_NAME)
    }

    /// Get current timestamp in seconds
    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    /// Find a node by path, returns TreeID if found
    fn find_node(&self, path: &str) -> Option<TreeID> {
        // Check cache first
        if let Some(id) = self.path_cache.read().unwrap().get(path) {
            return Some(*id);
        }

        let doc = self.doc.read().unwrap();
        let tree = doc.get_tree(TREE_NAME);

        // Walk tree to find node
        // Path format: "folder/subfolder/file.md"
        let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        if parts.is_empty() {
            return None;
        }

        let mut current_parent: Option<TreeID> = None;

        for (i, part) in parts.iter().enumerate() {
            let is_last = i == parts.len() - 1;
            let children = if let Some(parent) = current_parent {
                tree.children(&parent).unwrap_or_default()
            } else {
                tree.roots()
            };

            let mut found = false;
            for child_id in children {
                // Use get_meta to get the node's metadata map
                if let Ok(meta) = tree.get_meta(child_id) {
                    if let Some(loro::ValueOrContainer::Value(LoroValue::String(name))) = meta.get("name") {
                        if name.as_ref() == *part {
                            if is_last {
                                // Found the target node, cache it
                                self.path_cache.write().unwrap().insert(path.to_string(), child_id);
                                return Some(child_id);
                            }
                            current_parent = Some(child_id);
                            found = true;
                            break;
                        }
                    }
                }
            }

            if !found {
                return None;
            }
        }

        None
    }

    /// Create a node at path, creating parent folders as needed
    /// Returns the TreeID of the created/found node
    fn create_node_at_path(&self, path: &str, file_type: FileType) -> StoreResult<TreeID> {
        // Defense-in-depth: never store a path that could escape the vault when the
        // host later writes it to disk. Paths originate from peer CRDT data and are
        // therefore untrusted.
        validate_path(path)?;

        let doc = self.doc.write().unwrap();
        let tree = doc.get_tree(TREE_NAME);

        let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        if parts.is_empty() {
            return Err(StoreError::InvalidPath(path.to_string()));
        }

        let mut current_parent: Option<TreeID> = None;
        let now = Self::now_secs();

        for (i, part) in parts.iter().enumerate() {
            let is_last = i == parts.len() - 1;
            let children = if let Some(parent) = current_parent {
                tree.children(&parent).unwrap_or_default()
            } else {
                tree.roots()
            };

            // Check if this part already exists
            let mut found_id: Option<TreeID> = None;
            for child_id in children {
                if let Ok(meta) = tree.get_meta(child_id) {
                    if let Some(loro::ValueOrContainer::Value(LoroValue::String(name))) = meta.get("name") {
                        if name.as_ref() == *part {
                            found_id = Some(child_id);
                            break;
                        }
                    }
                }
            }

            if let Some(id) = found_id {
                if is_last {
                    // Node exists, return it
                    return Ok(id);
                }
                current_parent = Some(id);
            } else {
                // Create new node
                let node_id = tree.create(current_parent)
                    .map_err(|e| StoreError::Loro(e.to_string()))?;

                // Get the node's metadata map and set its data
                let meta = tree.get_meta(node_id)
                    .map_err(|e| StoreError::Loro(e.to_string()))?;
                meta.insert("name", part.to_string())
                    .map_err(|e| StoreError::Loro(e.to_string()))?;

                let node_type = if is_last { file_type } else { FileType::Folder };
                meta.insert("type", format!("{:?}", node_type).to_lowercase())
                    .map_err(|e| StoreError::Loro(e.to_string()))?;

                meta.insert("mtime", now as i64)
                    .map_err(|e| StoreError::Loro(e.to_string()))?;
                meta.insert("ctime", now as i64)
                    .map_err(|e| StoreError::Loro(e.to_string()))?;
                meta.insert("deleted", false)
                    .map_err(|e| StoreError::Loro(e.to_string()))?;

                if is_last {
                    // Cache and return
                    self.path_cache.write().unwrap().insert(path.to_string(), node_id);
                    return Ok(node_id);
                }
                current_parent = Some(node_id);
            }
        }

        Err(StoreError::InvalidPath(path.to_string()))
    }

    /// Build FileNode from tree node metadata
    fn node_to_file_node(&self, tree: &LoroTree, node_id: TreeID, path: &str) -> Option<FileNode> {
        let meta = tree.get_meta(node_id).ok()?;

        let file_type = match meta.get("type") {
            Some(loro::ValueOrContainer::Value(LoroValue::String(s))) => match s.as_ref() {
                "file" => FileType::File,
                "binary" => FileType::Binary,
                "folder" => FileType::Folder,
                _ => FileType::File,
            },
            _ => FileType::File,
        };

        let mime_type = match meta.get("mimeType") {
            Some(loro::ValueOrContainer::Value(LoroValue::String(s))) => Some(s.to_string()),
            _ => None,
        };

        let mtime = match meta.get("mtime") {
            Some(loro::ValueOrContainer::Value(LoroValue::I64(t))) => t as u64,
            _ => 0,
        };

        let ctime = match meta.get("ctime") {
            Some(loro::ValueOrContainer::Value(LoroValue::I64(t))) => t as u64,
            _ => 0,
        };

        let deleted = match meta.get("deleted") {
            Some(loro::ValueOrContainer::Value(LoroValue::Bool(b))) => b,
            _ => false,
        };

        let blob_hash = match meta.get("blobHash") {
            Some(loro::ValueOrContainer::Value(LoroValue::String(s))) => {
                let bytes = hex::decode(s.as_ref()).ok()?;
                if bytes.len() == 32 {
                    let mut hash = [0u8; 32];
                    hash.copy_from_slice(&bytes);
                    Some(hash)
                } else {
                    None
                }
            },
            _ => None,
        };

        Some(FileNode {
            path: path.to_string(),
            file_type,
            mime_type,
            mtime,
            ctime,
            deleted,
            blob_hash,
        })
    }

    /// Recursively list all files under a node
    fn list_files_recursive(
        &self,
        tree: &LoroTree,
        parent: Option<TreeID>,
        prefix: &str,
        results: &mut Vec<FileNode>,
        filter_prefix: Option<&str>,
    ) {
        let children = if let Some(p) = parent {
            tree.children(&p).unwrap_or_default()
        } else {
            tree.roots()
        };

        for child_id in children {
            let meta = match tree.get_meta(child_id) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let name = match meta.get("name") {
                Some(loro::ValueOrContainer::Value(LoroValue::String(s))) => s.to_string(),
                _ => continue,
            };

            // Reject peer-injected names that would escape the vault when the
            // host writes this path to disk (`..`, separators, NUL, drive colon).
            // Skip the whole subtree rooted at an unsafe name.
            if !is_safe_component(&name) {
                continue;
            }

            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", prefix, name)
            };

            // Check filter
            if let Some(fp) = filter_prefix {
                if !path.starts_with(fp) && !fp.starts_with(&path) {
                    continue;
                }
            }

            if let Some(file_node) = self.node_to_file_node(tree, child_id, &path) {
                if file_node.file_type == FileType::Folder {
                    // Recurse into folder
                    self.list_files_recursive(tree, Some(child_id), &path, results, filter_prefix);
                } else {
                    // Only add if passes filter
                    if filter_prefix.map(|fp| path.starts_with(fp)).unwrap_or(true) {
                        results.push(file_node);
                    }
                }
            }
        }
    }

    /// Invalidate path cache (call after structural changes)
    fn invalidate_cache(&self) {
        self.path_cache.write().unwrap().clear();
    }
}

impl DocStore for LoroStore {
    fn vault_id(&self) -> &[u8; 32] {
        &self.vault_id
    }

    fn version_vector(&self) -> Vec<u8> {
        let doc = self.doc.read().unwrap();
        doc.oplog_vv().encode()
    }

    fn export_updates(&self, since: Option<&[u8]>) -> StoreResult<Vec<u8>> {
        let doc = self.doc.read().unwrap();

        if let Some(vv_bytes) = since {
            let vv = loro::VersionVector::decode(vv_bytes)
                .map_err(|e| StoreError::Loro(e.to_string()))?;
            doc.export(ExportMode::updates(&vv))
                .map_err(|e| StoreError::Loro(e.to_string()))
        } else {
            doc.export(ExportMode::Snapshot)
                .map_err(|e| StoreError::Loro(e.to_string()))
        }
    }

    fn import_updates(&self, data: &[u8]) -> StoreResult<()> {
        let doc = self.doc.write().unwrap();
        doc.import(data)
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        drop(doc);
        self.invalidate_cache();
        Ok(())
    }

    fn export_snapshot(&self) -> StoreResult<Vec<u8>> {
        let doc = self.doc.read().unwrap();
        doc.export(ExportMode::Snapshot)
            .map_err(|e| StoreError::Loro(e.to_string()))
    }

    fn import_snapshot(&self, data: &[u8]) -> StoreResult<()> {
        let doc = self.doc.write().unwrap();
        doc.import(data)
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        drop(doc);
        self.invalidate_cache();
        Ok(())
    }

    fn get_text(&self, path: &str) -> StoreResult<Option<String>> {
        let node_id = match self.find_node(path) {
            Some(id) => id,
            None => return Ok(None),
        };

        let doc = self.doc.read().unwrap();
        let tree = doc.get_tree(TREE_NAME);
        let meta = tree.get_meta(node_id)
            .map_err(|e| StoreError::Loro(e.to_string()))?;

        // Check if deleted
        if let Some(loro::ValueOrContainer::Value(LoroValue::Bool(true))) = meta.get("deleted") {
            return Ok(None);
        }

        // Get content from separate text container
        if let Some(loro::ValueOrContainer::Value(LoroValue::String(content_key))) = meta.get("contentKey") {
            let text = doc.get_text(content_key.to_string());
            return Ok(Some(text.to_string()));
        }

        Ok(None)
    }

    fn set_text(&self, path: &str, content: &str) -> StoreResult<()> {
        let node_id = self.create_node_at_path(path, FileType::File)?;

        let doc = self.doc.write().unwrap();
        let tree = doc.get_tree(TREE_NAME);
        let meta = tree.get_meta(node_id)
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        let now = Self::now_secs();

        // Update metadata
        meta.insert("mtime", now as i64)
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        meta.insert("deleted", false)
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        meta.insert("type", "file")
            .map_err(|e| StoreError::Loro(e.to_string()))?;

        // Create or get content container
        // For simplicity, we use a unique key for each file's content
        let content_key = format!("content:{}", path);
        let text = doc.get_text(content_key.clone());

        // Clear existing content and set new
        let current_len = text.len_unicode();
        if current_len > 0 {
            text.delete(0, current_len)
                .map_err(|e| StoreError::Loro(e.to_string()))?;
        }
        text.insert(0, content)
            .map_err(|e| StoreError::Loro(e.to_string()))?;

        // Store reference to content container in node data
        meta.insert("contentKey", content_key)
            .map_err(|e| StoreError::Loro(e.to_string()))?;

        Ok(())
    }

    fn get_file(&self, path: &str) -> StoreResult<Option<FileNode>> {
        let node_id = match self.find_node(path) {
            Some(id) => id,
            None => return Ok(None),
        };

        let doc = self.doc.read().unwrap();
        let tree = doc.get_tree(TREE_NAME);

        Ok(self.node_to_file_node(&tree, node_id, path))
    }

    fn delete_file(&self, path: &str) -> StoreResult<()> {
        let node_id = match self.find_node(path) {
            Some(id) => id,
            None => return Err(StoreError::NotFound(path.to_string())),
        };

        let doc = self.doc.write().unwrap();
        let tree = doc.get_tree(TREE_NAME);
        let meta = tree.get_meta(node_id)
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        let now = Self::now_secs();

        // Soft delete
        meta.insert("deleted", true)
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        meta.insert("mtime", now as i64)
            .map_err(|e| StoreError::Loro(e.to_string()))?;

        // Remove from cache
        self.path_cache.write().unwrap().remove(path);

        Ok(())
    }

    fn list_files(&self, prefix: Option<&str>) -> StoreResult<Vec<FileNode>> {
        let doc = self.doc.read().unwrap();
        let tree = doc.get_tree(TREE_NAME);

        let mut results = Vec::new();
        self.list_files_recursive(&tree, None, "", &mut results, prefix);

        // Filter out deleted files
        results.retain(|f| !f.deleted);

        Ok(results)
    }

    fn create_folder(&self, path: &str) -> StoreResult<()> {
        self.create_node_at_path(path, FileType::Folder)?;
        Ok(())
    }

    fn set_binary(&self, path: &str, blob_hash: Hash, mime_type: Option<&str>) -> StoreResult<()> {
        let node_id = self.create_node_at_path(path, FileType::Binary)?;

        let doc = self.doc.write().unwrap();
        let tree = doc.get_tree(TREE_NAME);
        let meta = tree.get_meta(node_id)
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        let now = Self::now_secs();

        meta.insert("type", "binary")
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        meta.insert("blobHash", hex::encode(blob_hash))
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        meta.insert("mtime", now as i64)
            .map_err(|e| StoreError::Loro(e.to_string()))?;
        meta.insert("deleted", false)
            .map_err(|e| StoreError::Loro(e.to_string()))?;

        if let Some(mt) = mime_type {
            meta.insert("mimeType", mt)
                .map_err(|e| StoreError::Loro(e.to_string()))?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_and_get_text() {
        let store = LoroStore::new([1u8; 32]);

        // Set text
        store.set_text("notes/test.md", "Hello, World!").unwrap();

        // Get text
        let content = store.get_text("notes/test.md").unwrap();
        assert_eq!(content, Some("Hello, World!".to_string()));
    }

    #[test]
    fn test_list_files() {
        let store = LoroStore::new([1u8; 32]);

        store.set_text("a.md", "File A").unwrap();
        store.set_text("folder/b.md", "File B").unwrap();
        store.set_text("folder/c.md", "File C").unwrap();

        let files = store.list_files(None).unwrap();
        assert_eq!(files.len(), 3);

        let folder_files = store.list_files(Some("folder")).unwrap();
        assert_eq!(folder_files.len(), 2);
    }

    #[test]
    fn test_delete_file() {
        let store = LoroStore::new([1u8; 32]);

        store.set_text("test.md", "Content").unwrap();
        assert!(store.get_text("test.md").unwrap().is_some());

        store.delete_file("test.md").unwrap();

        // File should be soft-deleted (not returned in list)
        let files = store.list_files(None).unwrap();
        assert!(files.is_empty());

        // But metadata still exists
        let file = store.get_file("test.md").unwrap();
        assert!(file.is_some());
        assert!(file.unwrap().deleted);
    }

    #[test]
    fn test_export_import() {
        let store1 = LoroStore::new([1u8; 32]);
        store1.set_text("test.md", "Hello").unwrap();

        let snapshot = store1.export_snapshot().unwrap();

        let store2 = LoroStore::from_snapshot([1u8; 32], &snapshot).unwrap();
        let content = store2.get_text("test.md").unwrap();
        assert_eq!(content, Some("Hello".to_string()));
    }

    #[test]
    fn test_sync_updates() {
        let store1 = LoroStore::new([1u8; 32]);
        let store2 = LoroStore::new([1u8; 32]);

        // Initial sync
        let snapshot = store1.export_snapshot().unwrap();
        store2.import_snapshot(&snapshot).unwrap();

        // Store1 makes changes
        store1.set_text("file1.md", "From store 1").unwrap();

        // Get version before changes on store2
        let vv = store2.version_vector();

        // Export updates since that version
        let updates = store1.export_updates(Some(&vv)).unwrap();

        // Import to store2
        store2.import_updates(&updates).unwrap();

        // Verify sync
        let content = store2.get_text("file1.md").unwrap();
        assert_eq!(content, Some("From store 1".to_string()));
    }

    #[test]
    fn test_binary_file() {
        let store = LoroStore::new([1u8; 32]);

        let blob_hash = [42u8; 32];
        store.set_binary("image.png", blob_hash, Some("image/png")).unwrap();

        let file = store.get_file("image.png").unwrap().unwrap();
        assert_eq!(file.file_type, FileType::Binary);
        assert_eq!(file.blob_hash, Some(blob_hash));
        assert_eq!(file.mime_type, Some("image/png".to_string()));
    }
}
