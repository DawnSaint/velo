// macos_service_helper.m
//
// macOS 26 (Tahoe) ObjC 异常兼容辅助函数。
//
// macOS 26 修改了 ObjC 异常处理行为：之前能被静默忽略的 ObjC 异常现在会穿越
// extern "C" 边界，触发 panic_cannot_unwind → abort()，导致应用启动即崩溃。
// (tao#1171, tauri#15517)
//
// Rust 侧的 objc_exception::r#try (0.1.x) 内部用 catch_unwind 捕获 ObjC 异常，
// 但在 macOS 26 上 unwinder 穿越 extern "C" 帧时本身就会触发 panic_cannot_unwind,
// 即 catch 机制反而成了崩溃源头。
//
// 本文件把异常高危的 msg_send 调用封装在纯 ObjC 函数中，用 @try/@catch 在 ObjC
// 层吞掉异常，永不把 ObjC 异常抛过 FFI 边界。Rust 侧通过 FFI 调用本函数，只看到
// BOOL 返回值（YES 成功 / NO 失败）。
//
// 注意：本文件只用 ObjC runtime + Foundation + AppKit，不引用任何 Rust 符号，
// 完全自包含。

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

// 注册 VeloServiceProvider 到 NSApplication.sharedApplication。
// 内部用 @try/@catch 吞掉所有 ObjC 异常，返回 YES 成功 / NO 失败。
// Rust 侧的 ClassDecl 已经把类注册进 runtime，本函数只做实例化 + setServiceProvider。
BOOL velo_register_service_provider(const char *class_name) {
    @try {
        // 在 runtime 查找已注册的类。objc_getClass 需要 null 结尾的 C 字符串。
        Class cls = objc_getClass(class_name);
        if (cls == Nil) {
            NSLog(@"[velo] macos_service_helper: objc_getClass(%s) == nil", class_name);
            return NO;
        }
        // 实例化 service provider。
        id provider = [cls new];
        if (provider == nil) {
            NSLog(@"[velo] macos_service_helper: [%s new] == nil", class_name);
            return NO;
        }
        // 设置到 sharedApplication。
        NSApplication *app = [NSApplication sharedApplication];
        [app setServiceProvider:provider];
        return YES;
    } @catch (NSException *exception) {
        // 吞掉 ObjC 异常，永不抛过 FFI 边界。
        NSLog(@"[velo] macos_service_helper: ObjC 异常被吞掉: %@ — %@",
              [exception name], [exception reason]);
        return NO;
    }
}
