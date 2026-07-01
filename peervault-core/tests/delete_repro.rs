//! Regression test for the init-ops pending-import bug: a fresh `LoroStore`
//! must have an EMPTY op history, or deltas it authors carry causal deps on
//! private "init ops" that peers never received — Loro then silently parks
//! the delta as pending and remote soft-deletes never apply.

use peervault_core::store::{DocStore, LoroStore};

#[test]
fn remote_delete_applies_and_survives_echo() {
    let id = [7u8; 32];
    let a = LoroStore::new(id);
    a.set_text("seed.md", "content").unwrap();

    let b = LoroStore::new(id);
    b.import_updates(&a.export_updates(None).unwrap()).unwrap();
    assert_eq!(b.list_files(None).unwrap().len(), 1, "b synced");

    let vv_before = b.version_vector();
    b.delete_file("seed.md").unwrap();
    assert_eq!(b.list_files(None).unwrap().len(), 0, "b deleted locally");

    // b gossips the delta since vv_before -> a imports
    let delta = b.export_updates(Some(&vv_before)).unwrap();
    a.import_updates(&delta).unwrap();
    assert_eq!(a.list_files(None).unwrap().len(), 0, "remote delete must apply");

    // a re-gossips (mesh echo) -> b re-imports; must not resurrect
    let echo = a.export_updates(Some(&vv_before)).unwrap();
    b.import_updates(&echo).unwrap();
    assert_eq!(b.list_files(None).unwrap().len(), 0, "echo must not resurrect");
}

#[test]
fn fresh_store_has_empty_history() {
    let s = LoroStore::new([9u8; 32]);
    // An op-free doc encodes an empty version vector; any init write here would
    // reintroduce the pending-import class of bugs.
    assert_eq!(
        s.version_vector(),
        LoroStore::new([9u8; 32]).version_vector(),
        "fresh stores must have identical (empty) history"
    );
    assert_eq!(s.list_files(None).unwrap().len(), 0);
}

#[test]
fn delete_after_updates_mode_import() {
    // The sync path ships UPDATES-mode blobs (export_updates_since with the
    // peer's vv), not snapshots. Deleting a file that arrived that way must work.
    let id = [7u8; 32];
    let a = LoroStore::new(id);
    a.set_text("seed.md", "content").unwrap();
    a.set_text("notes/x.md", "nested").unwrap();

    let b = LoroStore::new(id);
    let empty_vv = b.version_vector();
    // updates-mode: export everything a has that b (empty) lacks
    b.import_updates(&a.export_updates(Some(&empty_vv)).unwrap()).unwrap();

    assert_eq!(b.get_text("seed.md").unwrap().as_deref(), Some("content"));
    assert_eq!(b.get_text("notes/x.md").unwrap().as_deref(), Some("nested"));

    b.delete_file("seed.md").expect("delete flat file after updates import");
    b.delete_file("notes/x.md").expect("delete nested file after updates import");
    assert_eq!(b.list_files(None).unwrap().len(), 0);
}

#[test]
fn concurrent_folder_creation_still_resolves_paths() {
    // Two peers create files under the same folder name concurrently — the
    // merge yields two sibling "notes" tree nodes. Path resolution must still
    // reach files in EITHER duplicate (first-match descent loses files).
    let id = [7u8; 32];
    let a = LoroStore::new(id);
    let b = LoroStore::new(id);
    a.set_text("notes/a.md", "from a").unwrap();
    b.set_text("notes/b.md", "from b").unwrap();

    let vv_empty = LoroStore::new(id).version_vector();
    let a_ops = a.export_updates(Some(&vv_empty)).unwrap();
    let b_ops = b.export_updates(Some(&vv_empty)).unwrap();
    a.import_updates(&b_ops).unwrap();
    b.import_updates(&a_ops).unwrap();

    // Both files visible on both peers
    assert_eq!(a.list_files(None).unwrap().len(), 2, "a sees both");
    assert_eq!(b.list_files(None).unwrap().len(), 2, "b sees both");

    // Reads resolve on both
    assert!(b.get_text("notes/a.md").unwrap().is_some(), "b reads a's file");
    assert!(a.get_text("notes/b.md").unwrap().is_some(), "a reads b's file");

    // Deletes resolve on both (the native-test failure)
    b.delete_file("notes/a.md").expect("b deletes a's file");
    a.import_updates(&b.export_updates(Some(&a.version_vector())).unwrap()).ok();
    assert!(
        !a.list_files(None).unwrap().iter().any(|f| f.path == "notes/a.md"),
        "delete must propagate"
    );
}
