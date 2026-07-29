# Changelog

All notable changes to this project will be documented in this file.

See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.7.6](https://github.com/DawnSaint/velo/compare/v0.7.5...v0.7.6) (2026-07-29)


### Features

* **editor:** add large document performance optimizations tier 1 ([a2d0d7b](https://github.com/DawnSaint/velo/commit/a2d0d7ba2b79cb9f3829576e4b8a636dbf4f2f98))
* **editor:** add viewport-aware decoration building (B1) ([76e3d50](https://github.com/DawnSaint/velo/commit/76e3d500b0d77f5dc0f65dd472410f585f4e71cf))
* **editor:** defer katex nodeview rendering to viewport (B3) ([de735a7](https://github.com/DawnSaint/velo/commit/de735a70f7877b335cd06eee2d5158781661c591))
* **notification:** add unified toast notification system ([30e473b](https://github.com/DawnSaint/velo/commit/30e473bf352148bcb325fbd7bbb7cae336daf5ee))


### Bug Fixes

* **tauri:** escape reserved keyword try and fix inner attribute placement ([c37955a](https://github.com/DawnSaint/velo/commit/c37955a436871c485e4f14a8d9480b7c7839be73))
* **tauri:** move macOS 26 ObjC exception handling to native helper to prevent startup crash ([1047f2c](https://github.com/DawnSaint/velo/commit/1047f2c6cc2e4783dc631131cee3c1186820ab64))
* **tauri:** remove macOS Finder Services integration ([8b16ad5](https://github.com/DawnSaint/velo/commit/8b16ad563560aa8db6aa462a1d9d2701e65798b1))
* **tauri:** use objc_exception crate directly for macOS 26 ObjC exception safety ([925428a](https://github.com/DawnSaint/velo/commit/925428ae9a8ae24bd92c2609300bc791c20e0665))


### Performance Improvements

* **editor:** add incremental DecorationSet updates for decoration plugins ([61134b0](https://github.com/DawnSaint/velo/commit/61134b04a1cd78b0b3b4e45785c3c38589f28b32))

## [0.7.5](https://github.com/DawnSaint/velo/compare/v0.7.4...v0.7.5) (2026-07-23)


### Features

* **editor:** add follow-system theme mode and fix macOS finder service crash ([361a85d](https://github.com/DawnSaint/velo/commit/361a85d9f7618ac32eb9f13f5f6c6b2986d4ea18))
* **settings:** add toggle for theme color affecting document content ([b14d522](https://github.com/DawnSaint/velo/commit/b14d5222fe630be8e20c26b9a063e4bf666f0e44))
* **settings:** unify dropdowns with VeloSelect, add theme swatches and no-theme option ([200f216](https://github.com/DawnSaint/velo/commit/200f216204276541bbfa78e9eb7dad0a4959242e))


### Bug Fixes

* **editor:** fix macOS build, settings Ctrl+F, and suppress browser shortcuts ([8befccb](https://github.com/DawnSaint/velo/commit/8befccb3af6ec06268d3b45bf3d57fb455bc3464))
* **editor:** fix startup flicker, tab restore order, and code block ancestor fold header ([2c558e6](https://github.com/DawnSaint/velo/commit/2c558e6c2031466979e6d3f8e240f9f757ee6d86))
* **editor:** preserve scroll position on tab switch ([7e854d2](https://github.com/DawnSaint/velo/commit/7e854d2f93c775b69672a8b942a1562b1955b602))

## [0.7.4](https://github.com/DawnSaint/velo/compare/v0.7.3...v0.7.4) (2026-07-22)


### Features

* **editor:** adapt macOS native window style and fix list backspace bug ([ca162ca](https://github.com/DawnSaint/velo/commit/ca162ca86bb334fc0aa53156de64c7fd4fa6e1a8))
* **editor:** add superscript `^x^` and subscript `~x~` syntax support ([6ab2447](https://github.com/DawnSaint/velo/commit/6ab2447e45ff32bf3d9f6273236e958ed05e45de))
* **editor:** parse standalone &lt;hr&gt; HTML as hr node and reveal file in tree on tab click ([adcf53e](https://github.com/DawnSaint/velo/commit/adcf53ed9c5315376433555f1b9d0ceb478a2007))
* **shell-integration:** implement "Open in Velo" folder context menu for macOS and Linux ([7a540ef](https://github.com/DawnSaint/velo/commit/7a540efe61b13e77d75cab8e1d62680a4f2a43b0))


### Bug Fixes

* **editor:** fix cjk punctuation breaking bold emphasis parsing and wrap up v0.7.4 ([843ff62](https://github.com/DawnSaint/velo/commit/843ff621abd5b76b49b192216ec164fbd1c4e875))

## [0.7.3](https://github.com/DawnSaint/velo/compare/v0.7.2...v0.7.3) (2026-07-20)


### Features

* **ci:** add macos x64 and appimage to release matrix ([67f35ed](https://github.com/DawnSaint/velo/commit/67f35edbe3e35d73605e5d32726e37691b6801e6))
* **settings:** add cross-group settings search and context-aware file menu ([9225725](https://github.com/DawnSaint/velo/commit/92257258d695c3b51210640617dad3dda6101c4a))
* **settings:** rebuild settings as full-page tab with extensible registry ([be8e3eb](https://github.com/DawnSaint/velo/commit/be8e3eb2b5c42e795a2ee7e0476326d07ec11503))
* **settings:** redesign settings as scrollable flow with outline navigation ([984eb4c](https://github.com/DawnSaint/velo/commit/984eb4cdebe3f5772ca79676fc35862decd3eb70))
* **settings:** redesign settings page tab bar and fix dark code styling ([96f318c](https://github.com/DawnSaint/velo/commit/96f318ce1067fbcbdb750863c7a5f6d6cf671cd5))
* **styles:** add floating overlay scrollbar for workspace panels ([a2dd77b](https://github.com/DawnSaint/velo/commit/a2dd77bf2c34cb6213cca6227e763f92356ea0b4))
* **topbar:** move file menu to top-bar logo slot and freeze tab width on close ([36caa1b](https://github.com/DawnSaint/velo/commit/36caa1b2736a3c1f543643cbf4435f26d7e2d487))
* **welcome:** inline WelcomeDialog on empty page and fix code block theme switching black screen ([90bc86f](https://github.com/DawnSaint/velo/commit/90bc86f95803a2c8f994c32e745ba8fe6c870805))

## [0.7.2](https://github.com/DawnSaint/velo/compare/v0.7.1...v0.7.2) (2026-07-17)


### Features

* **editor:** adapt HTML img tags as native image nodes ([adebd65](https://github.com/DawnSaint/velo/commit/adebd65eaaedd33efd41d0d65a66aa9c8ca2b51b))
* **editor:** add inline HTML click-to-expand source edit ([fafbfe8](https://github.com/DawnSaint/velo/commit/fafbfe8a1c2ff8924ddfe6af9f43f312d9ea72b3))
* **editor:** add underline mark with ctrl-u shortcut ([3c923e5](https://github.com/DawnSaint/velo/commit/3c923e57755f90e621eede5cbed3cded4ed806a9))
* **editor:** fold placeholder as real node + 0.7.2 docs wrap-up ([593f88b](https://github.com/DawnSaint/velo/commit/593f88bdca7d985779f99e1991cf09bac3123159))


### Bug Fixes

* **editor:** cast handleClickOn event to MouseEvent in fold test ([daf048c](https://github.com/DawnSaint/velo/commit/daf048cfc6428b17ff683ba3a58885cf5f436dad))
* **editor:** use code_block replacement for html_block source edit ([58a0a3e](https://github.com/DawnSaint/velo/commit/58a0a3eb63c70aad90077af21a5c91c22b29e980))

## [0.7.1](https://github.com/DawnSaint/velo/compare/v0.7.0...v0.7.1) (2026-07-17)


### Features

* **editor:** add table drag-to-resize, overflow fix and modern styling ([6f7e515](https://github.com/DawnSaint/velo/commit/6f7e5157381eeb40760d81ff5c2bb07b9fe9d4c0))
* **editor:** add table operations via shortcuts, context menu and column-resize cursor ([2d4d08c](https://github.com/DawnSaint/velo/commit/2d4d08cc4422aaad517f301f71898962014facbf))
* **editor:** add table pick handles, cell input guard, and fix sidebar layout ([49f13d6](https://github.com/DawnSaint/velo/commit/49f13d6a47eac37fdcdf750981ac27e5fde07e1f))
* **editor:** CellSelection batch operations and header-aware table editing ([64abc0b](https://github.com/DawnSaint/velo/commit/64abc0bf03b17c77d1fba7686b650b6cdbe81e0e))
* **editor:** table cell tab/enter navigation and pick-handle drag-select ([eed5787](https://github.com/DawnSaint/velo/commit/eed57872bbbdc88d34a97e9dfbedce61d58630e2))
* **editor:** table clipboard block-semantics, image-table detection, and 0.7.1 docs wrap-up ([9767d03](https://github.com/DawnSaint/velo/commit/9767d037291c844b892afb85fb1116e66ca1d5c2))
* **editor:** table editing — move/select/undo-cursor/insert-dots/context-menu shortcuts ([1e3950b](https://github.com/DawnSaint/velo/commit/1e3950b96769e0121fce5d09c88e032bc028007a))

## [0.7.0](https://github.com/DawnSaint/velo/compare/v0.6.7...v0.7.0) (2026-07-11)


### ⚠ BREAKING CHANGES

* **tauri:** installer format changes from MSI to NSIS; installation path moves from Program Files to LocalAppData; .md default handler is no longer set unconditionally (opt-in via checkbox). Existing MSI installation is not auto-uninstalled.

### Features

* **tauri:** per-user NSIS installer with opt-in shell integration + runtime controls ([105fa62](https://github.com/DawnSaint/velo/commit/105fa627bb8da333acedbb51fb886f33f378e9e6))
* **tauri:** switch windows installer from MSI to NSIS with per-user only and optional shell integration ([1f48877](https://github.com/DawnSaint/velo/commit/1f4887761d80189fa5b2f6c16290ab3364780f7d))


### Bug Fixes

* **editor:** animate code-block fold chevron on toggle ([dc0f674](https://github.com/DawnSaint/velo/commit/dc0f67455837a31d8853ae423d2be3271d6246e3))

## [0.6.7](https://github.com/DawnSaint/velo/compare/v0.6.6...v0.6.7) (2026-07-10)


### Features

* **editor:** add YAML front matter support with Typora-style NodeView ([3a9fc18](https://github.com/DawnSaint/velo/commit/3a9fc18d7f51dde1dad8f4cc4a4b7ed83dd7124b))
* **editor:** add YAML syntax highlighting for frontmatter and baseline lang curation ([de569bc](https://github.com/DawnSaint/velo/commit/de569bc81c3fdd8f0386fc94f23b6eb7b5e594d7))
* **editor:** frontmatter block collapsible ([299484b](https://github.com/DawnSaint/velo/commit/299484b8239a862308d03a343796ebb45fafc9f3))
* **editor:** TOML frontmatter support with YAML/TOML format switch ([74ea516](https://github.com/DawnSaint/velo/commit/74ea51659332a782714c01783e12f25d17007dc5))


### Bug Fixes

* **editor:** fix TOC not folding and delete button issues ([20456ec](https://github.com/DawnSaint/velo/commit/20456ec8dbcb2ac86410e62e65940d1154c66447))
* **editor:** resolve frontmatter premature-parse, empty-doc canonical, and release-please version sync ([313c738](https://github.com/DawnSaint/velo/commit/313c7382a6e4972de207cb71535a5f40c2c0c2b7))


### Documentation

* **claude:** split writing rules into per-doc 维护规范 and keep update conditions in CLAUDE.md ([b2ce72b](https://github.com/DawnSaint/velo/commit/b2ce72bc3e332d96eb5bc5b275e72b8b584302e3))

## [0.6.6](https://github.com/DawnSaint/velo/compare/v0.6.5...v0.6.6) (2026-07-09)


### Added

* **editor:** make hr selectable and deletable ([8d181e8](https://github.com/DawnSaint/velo/commit/8d181e8589a41ab3ed8693cae4175b4a41fe43cb))
* **editor:** unify atom node selection sync with shared selectionSync module ([be66849](https://github.com/DawnSaint/velo/commit/be66849cd669baaad64ba301e80db51863b6ce6d))


### Fixed

* **editor:** sample saveAs, mermaid header/fold/expand, line numbers + adjacent DOM order ([#3](https://github.com/DawnSaint/velo/issues/3)) ([e78939c](https://github.com/DawnSaint/velo/commit/e78939c97da388579e9c5bf44de4f5e0791d6fb9))


### Changed

* **release:** force patch version for next release ([23f70ef](https://github.com/DawnSaint/velo/commit/23f70ef5983f176b681632690cfffd2adf0bbdd3))
