fn main() {
    tauri_build::build();

    // git2(libgit2)在 Windows 上引用 advapi32(注册表)与 crypt32(随机数)
    // 的符号,但 rust-lld 默认不链这两个系统库 → undefined symbol
    // (CryptReleaseContext / RegCloseKey 等)。显式补链。
    // 实测验证见 docs/architecture/tauri.md Git 历史条目(Windows 链接)。
    if cfg!(target_os = "windows") {
        println!("cargo:rustc-link-lib=advapi32");
        println!("cargo:rustc-link-lib=crypt32");
    }
}
