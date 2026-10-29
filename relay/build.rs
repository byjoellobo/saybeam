//! Rebuild when the web app output changes, so `cargo build` after
//! `npm run build` always embeds the fresh files (including the first build).

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../apps/web/dist");
}
