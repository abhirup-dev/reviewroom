fn main() {
    // the app's one command, which the review pages (remote origins to Tauri) may call: capabilities/pages.json
    let manifest = tauri_build::AppManifest::new().commands(&["walkthrough_state"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri build");
}
