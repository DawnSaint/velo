# Changelog

All notable changes to this project will be documented in this file.

See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
