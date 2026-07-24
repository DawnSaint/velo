fn main() {
    #[cfg(target_os = "macos")]
    {
        // 编译 ObjC 辅助函数 macos_service_helper.m：
        // 用 @try/@catch 吞掉 ObjC 异常，避免异常穿越 extern "C" 边界触发
        // panic_cannot_unwind → abort (macOS 26 Tahoe)。
        cc::Build::new()
            .file("src/macos_service_helper.m")
            .compile("macos_service_helper");
    }
    tauri_build::build()
}
