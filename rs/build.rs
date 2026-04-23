use std::path::Path;

fn main() {
    let src = Path::new("../default.config.yaml");
    let dst = Path::new("default.config.yaml");
    if src.exists() {
        std::fs::copy(src, dst).expect("failed to copy default.config.yaml into rs/");
        println!("cargo:rerun-if-changed=../default.config.yaml");
    } else if !dst.exists() {
        panic!(
            "default.config.yaml not found — expected ../default.config.yaml (local) or ./default.config.yaml (CI cross-build)"
        );
    }
}
