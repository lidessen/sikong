fn main() {
    // Embed the version string at build time.
    // Priority: SIKO_VERSION env var > GITHUB_REF_NAME > Cargo.toml version
    let version = std::env::var("SIKO_VERSION")
        .or_else(|_| std::env::var("GITHUB_REF_NAME"))
        .unwrap_or_else(|_| std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.1.0-dev".into()));
    println!("cargo:rustc-env=SIKO_BUILD_VERSION={}", version);
    println!("cargo:rerun-if-env-changed=SIKO_VERSION");
    println!("cargo:rerun-if-env-changed=GITHUB_REF_NAME");
}
