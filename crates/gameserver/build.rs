//! Embeds the built web client (client/dist) into the server binary, so a
//! single file is the whole deployment. Generates OUT_DIR/static_assets.rs
//! with one include_bytes! entry per dist file.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "wasm" => "application/wasm",
        "json" | "map" => "application/json",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, PathBuf)>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            walk(&path, root, out);
        } else {
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .components()
                .map(|c| c.as_os_str().to_str().unwrap())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, path));
        }
    }
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let dist = manifest.join("../../client/dist");
    // Cargo watches directories recursively; also fires when a missing dist appears.
    println!("cargo:rerun-if-changed={}", dist.display());

    let mut files = Vec::new();
    if dist.join("index.html").exists() {
        walk(&dist, &dist, &mut files);
        files.sort();
    } else if env::var("PROFILE").as_deref() == Ok("release") {
        panic!(
            "client/dist/index.html not found — release builds embed the web client.\n\
             Build it first:  cd client && bun install && bun run wasm && bun run build"
        );
    } else {
        println!(
            "cargo:warning=client/dist not built; server will have no embedded web client \
             (fine for `cargo test`, run `bun run build` in client/ to fix)"
        );
    }

    let mut src = String::from(
        "pub struct StaticAsset {\n    pub path: &'static str,\n    pub mime: &'static str,\n    pub bytes: &'static [u8],\n}\n\npub static STATIC_ASSETS: &[StaticAsset] = &[\n",
    );
    for (rel, abs) in &files {
        writeln!(
            src,
            "    StaticAsset {{ path: {:?}, mime: {:?}, bytes: include_bytes!({:?}) }},",
            rel,
            mime_for(abs),
            abs.canonicalize().unwrap()
        )
        .unwrap();
    }
    src.push_str("];\n");

    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("static_assets.rs");
    fs::write(out, src).unwrap();
}
