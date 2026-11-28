//! 系统字体查询与 PDF 子集化服务（#pdf-font-fidelity）。
//!
//! 为什么在 Rust 侧直接子集化而不传完整系统字体给前端：
//!   Windows 微软雅黑 msyh.ttc（18.8MB）两个 face 共享同一张 17.8MB glyf 表，
//!   拆单 face 仍 ~18.7MB；macOS PingFang.ttc ~70MB。在 Rust 侧用 fontdb +
//!   ttf-parser + subsetter 直接按文档字符集子集化，实测 ~1ms、产物 ~30–140KB，
//!   跨 IPC 体积降 ~150 倍，同时一并算出 FontMeta 免前端再跑 opentype.js。
//!
//! 约束：subsetter 产物为最小化 PDF 体积故意移除 cmap 表，仅用于 PDF CIDFontType2
//! 嵌入，不能喂浏览器 @font-face；系统字体的 DOM 预览由前端直接使用本机 font-family。

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use fontdb::{Database, Family, ID, Query, Stretch, Style, Weight};
use serde::Serialize;

use crate::color_fonts::{self, Type3FontData, Type3ResourceCollector};

/// 进程内共享的系统字体数据库（首次调用扫描一次，后续查询 <0.1ms）。
static FONT_DB: OnceLock<Database> = OnceLock::new();

fn font_db() -> &'static Database {
    FONT_DB.get_or_init(|| {
        let mut db = Database::new();
        db.load_system_fonts();
        db
    })
}

/// 与前端 `pdfPreview/fontSubset.ts` 的 `FontMeta` 同构。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontMeta {
    pub upem: u16,
    /// 字符 → [子集后新 gid, 1000 单位字宽]
    pub chars: HashMap<String, [u16; 2]>,
    /// 按新 gid 顺序的 1000 单位字宽表（含 gid 0 `.notdef`）
    pub widths: Vec<u16>,
    /// [xMin, yMin, xMax, yMax]（原始 font units）
    pub bbox: [i16; 4],
    pub ascent: i32,
    pub descent: i32,
    pub cap_height: i32,
    pub glyph_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSubsetFont {
    /// 实际命中的系统字体族名（供前端 DOM 预览直接使用）
    pub family: String,
    pub weight: u16,
    pub italic: bool,
    pub meta: SystemFontMeta,
    /// 子集 TTF 字节（base64 编码，几十 KB 级）；纯 Type3 彩色字体时为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttf_base64: Option<String>,
    /// PDF Type3 彩色字形数据（COLR v0/v1 矢量或 sbix/CBDT 位图）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type3: Option<Type3FontData>,
}

/// CSS generic family 映射：不直接作为字体名查询；对系统 UI 别名给一个平台合理映射。
fn resolve_family_candidates(name: &str) -> Vec<&str> {
    let trimmed = name.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    if trimmed.is_empty() {
        return vec![];
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "serif" | "sans-serif" | "monospace" | "cursive" | "fantasy" | "ui-serif"
        | "ui-sans-serif" | "ui-rounded" | "math" | "emoji" | "fangsong" => vec![],
        "system-ui" | "-apple-system" | "blinkmacsystemfont" => {
            #[cfg(target_os = "macos")]
            {
                vec!["SF Pro Text", "PingFang SC", "Helvetica Neue"]
            }
            #[cfg(target_os = "windows")]
            {
                vec!["Segoe UI", "Microsoft YaHei"]
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                vec!["Noto Sans", "DejaVu Sans"]
            }
        }
        "ui-monospace" => {
            #[cfg(target_os = "macos")]
            {
                vec!["SF Mono", "Menlo"]
            }
            #[cfg(target_os = "windows")]
            {
                vec!["Cascadia Code", "Consolas"]
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                vec!["DejaVu Sans Mono", "Liberation Mono"]
            }
        }
        _ => vec![trimmed],
    }
}

/// 跨平台彩色 emoji 字体优先表：兜底阶段先以 `color_only = true` 跑一轮，
/// 确保 ✅ / 🎉 / ⚠(⚠️) / ❤(❤️) 等彩色 emoji 不被单色正文字体或符号字体截胡，
/// 同时不误吞 ①② 等非彩色字符。
const COLOR_EMOJI_PRIORITY: &[&str] = &[
    "Apple Color Emoji",
    "Segoe UI Emoji",
    "Noto Color Emoji",
];

/// 跨平台常见兜底字体优先级（在全库扫描前先查，避免缺字落到冷门或装饰字体）。
const FALLBACK_PRIORITY: &[&str] = &[
    "Microsoft YaHei",
    "PingFang SC",
    "Segoe UI Symbol",
    "Apple Symbols",
    "Cambria",
    "Cambria Math",
    "SimSun",
    "Songti SC",
    "Noto Sans CJK SC",
    "Noto Sans Symbols",
    "Noto Sans Symbols 2",
    "SimSun-ExtB",
    "MingLiU-ExtB",
    "DejaVu Sans",
    "Arial Unicode MS",
];

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn round_1000(val: i32, upem: u16) -> i32 {
    if upem == 0 {
        return val;
    }
    ((val as f64) / (upem as f64) * 1000.0).round() as i32
}

/// 对指定 `ID` 的系统字体按 `chars` 做子集化 / Type3 彩色提取并计算度量。
///
/// 彩色字形（COLR v0/v1 或 sbix/CBDT PNG）与普通单色轮廓字形分离产出：
/// - 彩色字形按最多 255 个/片切分为 Type3 字体（单字节编码 1..=255 + ToUnicode）
/// - 单色轮廓字形走 `subsetter::subset` 产出 CIDFontType2 子集 TTF
/// 若某字形在彩色提取中失败（如损坏表），自动降级回单色轮廓子集化。
fn subset_face_id_multi(
    db: &Database,
    id: ID,
    chars: &[char],
    preferred_family: Option<&str>,
    color_only: bool,
) -> Vec<SystemSubsetFont> {
    let Some(info) = db.face(id) else {
        return Vec::new();
    };
    let family_name = preferred_family
        .map(str::to_string)
        .or_else(|| info.families.first().map(|(n, _)| n.clone()))
        .unwrap_or_default();
    let weight = info.weight.0;
    let italic = info.style != Style::Normal;

    let mut outputs: Vec<SystemSubsetFont> = Vec::new();

    db.with_face_data(id, |data, face_index| {
        let Ok(face) = ttf_parser::Face::parse(data, face_index) else {
            return;
        };
        let upem = face.units_per_em();
        if upem == 0 {
            return;
        }

        let bbox = face.global_bounding_box();
        let bbox_arr = [bbox.x_min, bbox.y_min, bbox.x_max, bbox.y_max];
        let ascent = round_1000(face.ascender() as i32, upem);
        let descent = round_1000(face.descender() as i32, upem);
        let cap_height = round_1000(
            face.capital_height().unwrap_or(face.ascender()) as i32,
            upem,
        );

        let mut color_matched: Vec<(char, ttf_parser::GlyphId, u16)> = Vec::new();
        let mut mono_matched: Vec<(char, u16)> = Vec::new();

        for &ch in chars {
            let Some(gid) = face.glyph_index(ch) else {
                continue;
            };
            if gid.0 == 0 {
                continue;
            }
            if color_fonts::has_color_glyph(&face, gid) {
                let adv = face.glyph_hor_advance(gid).unwrap_or(upem);
                let w1000 = round_1000(adv as i32, upem).clamp(0, u16::MAX as i32) as u16;
                color_matched.push((ch, gid, w1000));
            } else if !color_only {
                mono_matched.push((ch, gid.0));
            }
        }

        // 1. 彩色字形 → Type3（每片最多 255 个字符）
        if !color_matched.is_empty() {
            for chunk in color_matched.chunks(255) {
                let mut res = Type3ResourceCollector::new();
                let mut char_procs: HashMap<u8, String> = HashMap::with_capacity(chunk.len());
                let mut char_map: HashMap<String, [u16; 2]> = HashMap::with_capacity(chunk.len());
                let mut widths: Vec<u16> = vec![0];
                let mut next_code: u8 = 1;

                for &(ch, gid, w1000) in chunk {
                    if let Some(proc_ops) = color_fonts::build_color_char_proc(
                        &face,
                        gid,
                        w1000,
                        upem,
                        &mut res,
                        encode_base64,
                    ) {
                        let code = next_code;
                        next_code = next_code.saturating_add(1);
                        char_procs.insert(code, proc_ops);
                        char_map.insert(ch.to_string(), [code as u16, w1000]);
                        widths.push(w1000);
                    } else {
                        // 彩色提取失败时降级到单色子集通道
                        mono_matched.push((ch, gid.0));
                    }
                }

                if !char_procs.is_empty() {
                    let glyph_count = widths.len();
                    outputs.push(SystemSubsetFont {
                        family: family_name.clone(),
                        weight,
                        italic,
                        meta: SystemFontMeta {
                            upem,
                            chars: char_map,
                            widths,
                            bbox: bbox_arr,
                            ascent,
                            descent,
                            cap_height,
                            glyph_count,
                        },
                        ttf_base64: None,
                        type3: Some(Type3FontData {
                            char_procs,
                            alphas: res.alphas,
                            soft_masks: res.soft_masks,
                            shadings: res.shadings,
                            images: res.images,
                        }),
                    });
                }
            }
        }

        // 2. 单色轮廓字形 → CIDFontType2 子集 TTF
        if color_only || mono_matched.is_empty() {
            return;
        }
        let mut remapper = subsetter::GlyphRemapper::new();
        for &(_, old_gid) in &mono_matched {
            remapper.remap(old_gid);
        }
        if let Some(sp) = face.glyph_index(' ') {
            if sp.0 != 0 {
                remapper.remap(sp.0);
            }
        }

        let Ok(sub_ttf) = subsetter::subset(data, face_index, &remapper) else {
            return;
        };

        let num_glyphs = remapper.num_gids() as usize;
        let mut widths = vec![0u16; num_glyphs];
        for (new_gid, old_gid) in remapper.remapped_gids().enumerate() {
            if new_gid < num_glyphs {
                let adv = face
                    .glyph_hor_advance(ttf_parser::GlyphId(old_gid))
                    .unwrap_or(0);
                let w1000 = round_1000(adv as i32, upem).clamp(0, u16::MAX as i32) as u16;
                widths[new_gid] = w1000;
            }
        }

        let mut char_map = HashMap::with_capacity(mono_matched.len() + 1);
        for (ch, old_gid) in mono_matched {
            if let Some(new_gid) = remapper.get(old_gid) {
                let w = widths.get(new_gid as usize).copied().unwrap_or(0);
                char_map.insert(ch.to_string(), [new_gid, w]);
            }
        }
        if !char_map.contains_key(" ") {
            if let Some(sp) = face.glyph_index(' ') {
                if let Some(new_gid) = remapper.get(sp.0) {
                    let w = widths.get(new_gid as usize).copied().unwrap_or(0);
                    char_map.insert(" ".to_string(), [new_gid, w]);
                }
            }
        }

        outputs.push(SystemSubsetFont {
            family: family_name.clone(),
            weight,
            italic,
            meta: SystemFontMeta {
                upem,
                chars: char_map,
                widths,
                bbox: bbox_arr,
                ascent,
                descent,
                cap_height,
                glyph_count: num_glyphs,
            },
            ttf_base64: Some(encode_base64(&sub_ttf)),
            type3: None,
        });
    });

    outputs
}

/// 按 CSS 字体族候选列表查找第一个命中的系统字体并按 `chars` 子集化。
#[tauri::command]
pub async fn resolve_and_subset_system_font(
    families: Vec<String>,
    weight: u16,
    italic: bool,
    chars: String,
) -> Result<Option<SystemSubsetFont>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = font_db();
        let unique_chars: Vec<char> = {
            let mut seen = HashSet::new();
            chars.chars().filter(|c| seen.insert(*c)).collect()
        };
        if unique_chars.is_empty() {
            return None;
        }
        let style = if italic { Style::Italic } else { Style::Normal };
        let w = Weight(weight);

        for raw in &families {
            for cand in resolve_family_candidates(raw) {
                let query = Query {
                    families: &[Family::Name(cand)],
                    weight: w,
                    stretch: Stretch::Normal,
                    style,
                };
                if let Some(id) = db.query(&query) {
                    let subs = subset_face_id_multi(db, id, &unique_chars, Some(cand), false);
                    if let Some(sub) = subs.into_iter().next() {
                        return Some(sub);
                    }
                }
            }
        }
        None
    })
    .await
    .map_err(|e| format!("系统字体子集化线程异常: {e}"))
}

/// 为主字体栈均未覆盖的剩余字符查找系统兜底字体并子集化。
///
/// 先按 `FALLBACK_PRIORITY` 查找，剩余字符再扫全库常规字重 face。
/// 每个命中的兜底字体只子集化它负责的那批缺字，返回列表按命中顺序排列。
#[tauri::command]
pub async fn fallback_subset_system_fonts(
    missing_chars: String,
    weight: u16,
) -> Result<Vec<SystemSubsetFont>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = font_db();
        let mut remaining: Vec<char> = {
            let mut seen = HashSet::new();
            missing_chars
                .chars()
                .filter(|c| !c.is_whitespace() && seen.insert(*c))
                .collect()
        };
        if remaining.is_empty() {
            return Vec::new();
        }

        let mut out: Vec<SystemSubsetFont> = Vec::new();
        let mut tried_ids: HashSet<ID> = HashSet::new();
        let target_weight = Weight(weight);

        // 0. 优先从系统彩色 emoji 字体提取彩色字形（color_only=true，不误吞单色字符）
        for &fam in COLOR_EMOJI_PRIORITY {
            if remaining.is_empty() {
                break;
            }
            let Some(id) = db.query(&Query {
                families: &[Family::Name(fam)],
                weight: Weight::NORMAL,
                stretch: Stretch::Normal,
                style: Style::Normal,
            }) else {
                continue;
            };
            let subs = subset_face_id_multi(db, id, &remaining, Some(fam), true);
            for sub in subs {
                remaining.retain(|ch| !sub.meta.chars.contains_key(&ch.to_string()));
                out.push(sub);
            }
        }

        // 1. 优先查常见符号 / CJK 系统字体
        for &fam in FALLBACK_PRIORITY {
            if remaining.is_empty() {
                break;
            }
            let id = db
                .query(&Query {
                    families: &[Family::Name(fam)],
                    weight: target_weight,
                    stretch: Stretch::Normal,
                    style: Style::Normal,
                })
                .or_else(|| {
                    db.query(&Query {
                        families: &[Family::Name(fam)],
                        weight: Weight::NORMAL,
                        stretch: Stretch::Normal,
                        style: Style::Normal,
                    })
                });
            let Some(id) = id else { continue };
            if !tried_ids.insert(id) {
                continue;
            }
            let subs = subset_face_id_multi(db, id, &remaining, Some(fam), false);
            for sub in subs {
                remaining.retain(|ch| !sub.meta.chars.contains_key(&ch.to_string()));
                out.push(sub);
            }
        }

        // 2. 仍有未覆盖字符时扫全库常规 face
        if !remaining.is_empty() {
            let candidate_ids: Vec<ID> = db
                .faces()
                .filter(|f| f.style == Style::Normal && (f.weight == Weight::NORMAL || f.weight == target_weight))
                .map(|f| f.id)
                .collect();

            for id in candidate_ids {
                if remaining.is_empty() {
                    break;
                }
                if !tried_ids.insert(id) {
                    continue;
                }
                let subs = subset_face_id_multi(db, id, &remaining, None, false);
                for sub in subs {
                    remaining.retain(|ch| !sub.meta.chars.contains_key(&ch.to_string()));
                    out.push(sub);
                }
            }
        }

        out
    })
    .await
    .map_err(|e| format!("系统兜底字体查找线程异常: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_base64_matches_rfc4648() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_msyh_and_fallback_cover_circled_and_check() {
        let db = font_db();
        let id = db
            .query(&Query {
                families: &[Family::Name("Microsoft YaHei")],
                weight: Weight::NORMAL,
                stretch: Stretch::Normal,
                style: Style::Normal,
            })
            .expect("Windows should have Microsoft YaHei");
        let chars: Vec<char> = "你好世界①②ABC".chars().collect();
        let subs = subset_face_id_multi(db, id, &chars, Some("Microsoft YaHei"), false);
        assert_eq!(subs.len(), 1);
        let sub = &subs[0];
        assert!(sub.meta.chars.contains_key("①"));
        assert!(sub.meta.chars.contains_key("②"));
        assert!(sub.meta.chars.contains_key("你"));
        assert!(sub.meta.glyph_count > 5);
        assert!(sub.ttf_base64.as_deref().is_some_and(|s| !s.is_empty()));
        assert!(sub.type3.is_none());

        // ✅ 🎉 🔥 ⚠ 应由 Segoe UI Emoji 产出 Type3 彩色字形（color_only 不误吞 ①②）
        assert!(!sub.meta.chars.contains_key("✅"));
        let emoji_id = db
            .query(&Query {
                families: &[Family::Name("Segoe UI Emoji")],
                weight: Weight::NORMAL,
                stretch: Stretch::Normal,
                style: Style::Normal,
            })
            .expect("Windows should have Segoe UI Emoji");
        let emoji_chars: Vec<char> = "✅🎉🔥⚠😅①".chars().collect();
        let emoji_subs = subset_face_id_multi(db, emoji_id, &emoji_chars, Some("Segoe UI Emoji"), true);
        assert_eq!(emoji_subs.len(), 1);
        let emoji_sub = &emoji_subs[0];
        assert!(emoji_sub.ttf_base64.is_none());
        assert!(!emoji_sub.meta.chars.contains_key("①"));
        let t3 = emoji_sub.type3.as_ref().expect("Segoe UI Emoji should produce Type3 color glyphs");
        assert!(
            !t3.soft_masks.is_empty(),
            "COLR v1 alpha gradients in 😅 should produce Luminosity soft masks"
        );
        for ch in ["✅", "🎉", "🔥", "⚠", "😅"] {
            let [code, w] = emoji_sub.meta.chars[ch];
            assert!(code >= 1 && code <= 255);
            assert!(w > 0);
            let ops = t3.char_procs.get(&(code as u8)).expect("char_proc missing");
            assert!(ops.contains(" d0\n"), "CharProc must start with d0: {ops}");
            assert!(
                ops.contains(" rg\n") || ops.contains(" sh\n"),
                "Color emoji CharProc must emit color/shading ops: {ops}"
            );
        }
    }
}
