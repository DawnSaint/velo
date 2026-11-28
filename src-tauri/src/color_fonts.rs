//! 彩色字体（COLR v0/v1 矢量 + sbix/CBDT PNG 位图）→ PDF Type3 字形数据提取器。
//!
//! 跨平台覆盖：
//! - Windows `Segoe UI Emoji`（COLR v0/v1）→ 矢量路径 / 渐变 Shading，任意缩放锐利
//! - macOS `Apple Color Emoji`（sbix PNG）→ FlateDecode RGB + SMask Image XObject
//! - Linux `Noto Color Emoji`（CBDT PNG 或 COLR v1）→ 同上双通道自动适配
//!
//! 每个 Type3 字体最多承载 255 个字符（单字节编码 1..=255）；超限时由调用方分片成多个
//! Type3 槽位。所有坐标在 CharProc 内先 `w1000 0 d0` 再 `s 0 0 s 0 0 cm`（`s = 1000 / upem`），
//! 与 `/FontMatrix [0.001 0 0 0.001 0 0]` 配合，使 `/Widths` 与布局引擎 1000 单位完全一致。

use std::collections::HashMap;
use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde::Serialize;
use ttf_parser::colr::{ClipBox, CompositeMode, LinearGradient, Paint, Painter, RadialGradient};
use ttf_parser::{Face, GlyphId, OutlineBuilder, RasterImageFormat, RgbaColor, Transform};

/// Type3 字体内嵌的位图 XObject（用于 sbix / CBDT PNG 彩色 emoji）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Type3Image {
    /// Type3 `/Resources /XObject` 内的资源名（如 `Im0`）
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// FlateDecode 压缩后的 DeviceRGB 字节（base64）
    pub rgb_flate_base64: String,
    /// FlateDecode 压缩后的 DeviceGray SMask 透明通道（全不透明时省略）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha_flate_base64: Option<String>,
}

/// Type3 字体内嵌的 PDF Shading 字典（用于 COLR v1 线性 / 径向渐变）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Type3Shading {
    /// Type3 `/Resources /Shading` 内的资源名（如 `Sh0`）
    pub name: String,
    /// 完整 PDF Shading 字典字符串（`<< /ShadingType ... >>`）
    pub pdf_dict: String,
}

/// Type3 字体内嵌的渐变透明软遮罩（用于 COLR v1 逐 stop alpha 变化的渐变，如边缘阴影/高光）。
///
/// PDF Shading 本身不支持逐 stop alpha；用同几何参数的 `/DeviceGray` Shading 装进
/// Transparency Form XObject 作为 `/ExtGState /SMask /S /Luminosity`，可精确还原
/// `alpha: 0 -> 0.6` 等渐隐效果，避免均值 `/ca` 把整张脸蒙灰。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Type3SoftMask {
    /// Type3 `/Resources /ExtGState` 内的资源名（如 `GSsm0`）
    pub name: String,
    /// 同几何参数的 `/DeviceGray` PDF Shading 字典
    pub shading_dict: String,
    /// Form XObject 覆盖范围 `[xMin, yMin, xMax, yMax]`（字体单位）
    pub bbox: [f32; 4],
}

/// PDF Type3 彩色字体数据（单字节编码 1..=255）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Type3FontData {
    /// 字符编码（1..=255）→ PDF CharProc 内容流
    pub char_procs: HashMap<u8, String>,
    /// ExtGState 常量透明度资源表：`[("GSa0", 0.5), ...]`
    pub alphas: Vec<(String, f32)>,
    /// ExtGState 渐变软遮罩资源表（逐 stop alpha 渐变）
    pub soft_masks: Vec<Type3SoftMask>,
    /// COLR v1 渐变资源表
    pub shadings: Vec<Type3Shading>,
    /// sbix / CBDT 位图资源表
    pub images: Vec<Type3Image>,
}

/// 判断给定 `gid` 在当前 `face` 中是否有彩色字形数据（COLR 或 PNG 位图）。
pub fn has_color_glyph(face: &Face<'_>, gid: GlyphId) -> bool {
    if face.is_color_glyph(gid) {
        return true;
    }
    if let Some(img) = face.glyph_raster_image(gid, 128) {
        if img.format == RasterImageFormat::PNG && !img.data.is_empty() {
            return true;
        }
    }
    false
}

fn fmt_num(v: f32) -> String {
    if !v.is_finite() {
        return "0".to_string();
    }
    let rounded = (v * 100.0).round() / 100.0;
    if rounded == 0.0 {
        "0".to_string()
    } else if (rounded.fract()).abs() < 1e-6 {
        format!("{}", rounded as i64)
    } else {
        let s = format!("{rounded:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn fmt_color_comp(c: u8) -> String {
    let v = (c as f32 / 255.0 * 1000.0).round() / 1000.0;
    let s = format!("{v:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn rgb_str(c: RgbaColor) -> String {
    format!(
        "{} {} {}",
        fmt_color_comp(c.red),
        fmt_color_comp(c.green),
        fmt_color_comp(c.blue)
    )
}

/// TrueType 轮廓 → PDF 路径算子（二次贝塞尔精确升阶为三次贝塞尔）。
struct PdfOutlineBuilder {
    ops: String,
    cur_x: f32,
    cur_y: f32,
}

impl PdfOutlineBuilder {
    fn new() -> Self {
        Self {
            ops: String::new(),
            cur_x: 0.0,
            cur_y: 0.0,
        }
    }
}

impl OutlineBuilder for PdfOutlineBuilder {
    fn move_to(&mut self, x: f32, y: f32) {
        self.ops
            .push_str(&format!("{} {} m ", fmt_num(x), fmt_num(y)));
        self.cur_x = x;
        self.cur_y = y;
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.ops
            .push_str(&format!("{} {} l ", fmt_num(x), fmt_num(y)));
        self.cur_x = x;
        self.cur_y = y;
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        // 精确二次 → 三次贝塞尔升阶
        let cx1 = self.cur_x + (2.0 / 3.0) * (x1 - self.cur_x);
        let cy1 = self.cur_y + (2.0 / 3.0) * (y1 - self.cur_y);
        let cx2 = x + (2.0 / 3.0) * (x1 - x);
        let cy2 = y + (2.0 / 3.0) * (y1 - y);
        self.ops.push_str(&format!(
            "{} {} {} {} {} {} c ",
            fmt_num(cx1),
            fmt_num(cy1),
            fmt_num(cx2),
            fmt_num(cy2),
            fmt_num(x),
            fmt_num(y),
        ));
        self.cur_x = x;
        self.cur_y = y;
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.ops.push_str(&format!(
            "{} {} {} {} {} {} c ",
            fmt_num(x1),
            fmt_num(y1),
            fmt_num(x2),
            fmt_num(y2),
            fmt_num(x),
            fmt_num(y),
        ));
        self.cur_x = x;
        self.cur_y = y;
    }

    fn close(&mut self) {
        self.ops.push_str("h ");
    }
}

/// 单个 Type3 字体片共享的资源收集器（ExtGState / Shading / Image XObject）。
pub struct Type3ResourceCollector {
    pub alphas: Vec<(String, f32)>,
    alpha_map: HashMap<u8, String>,
    pub soft_masks: Vec<Type3SoftMask>,
    pub shadings: Vec<Type3Shading>,
    pub images: Vec<Type3Image>,
}

impl Type3ResourceCollector {
    pub fn new() -> Self {
        Self {
            alphas: Vec::new(),
            alpha_map: HashMap::new(),
            soft_masks: Vec::new(),
            shadings: Vec::new(),
            images: Vec::new(),
        }
    }

    fn intern_alpha(&mut self, alpha_u8: u8) -> String {
        if let Some(name) = self.alpha_map.get(&alpha_u8) {
            return name.clone();
        }
        let name = format!("GSa{}", self.alphas.len());
        let val = ((alpha_u8 as f32 / 255.0) * 1000.0).round() / 1000.0;
        self.alphas.push((name.clone(), val));
        self.alpha_map.insert(alpha_u8, name.clone());
        name
    }

    fn push_soft_mask(&mut self, shading_dict: String, bbox: [f32; 4]) -> String {
        let name = format!("GSsm{}", self.soft_masks.len());
        self.soft_masks.push(Type3SoftMask {
            name: name.clone(),
            shading_dict,
            bbox,
        });
        name
    }

    fn push_shading(&mut self, pdf_dict: String) -> String {
        let name = format!("Sh{}", self.shadings.len());
        self.shadings.push(Type3Shading {
            name: name.clone(),
            pdf_dict,
        });
        name
    }

    fn push_image(
        &mut self,
        width: u32,
        height: u32,
        rgb_flate_base64: String,
        alpha_flate_base64: Option<String>,
    ) -> String {
        let name = format!("Im{}", self.images.len());
        self.images.push(Type3Image {
            name: name.clone(),
            width,
            height,
            rgb_flate_base64,
            alpha_flate_base64,
        });
        name
    }
}

/// 构造 PDF 梯度插值函数字典（2 stop 用 Type 2，多 stop 用 Type 3 Stitching）。
fn build_gradient_function_with(stops: &[(f32, RgbaColor)], fmt_stop: fn(RgbaColor) -> String) -> String {
    if stops.len() == 2 {
        return format!(
            "<< /FunctionType 2 /Domain [0 1] /C0 [{}] /C1 [{}] /N 1 >>",
            fmt_stop(stops[0].1),
            fmt_stop(stops[1].1),
        );
    }
    let mut funcs = Vec::with_capacity(stops.len() - 1);
    let mut bounds = Vec::with_capacity(stops.len() - 2);
    let mut encode = Vec::with_capacity((stops.len() - 1) * 2);
    for i in 0..stops.len() - 1 {
        funcs.push(format!(
            "<< /FunctionType 2 /Domain [0 1] /C0 [{}] /C1 [{}] /N 1 >>",
            fmt_stop(stops[i].1),
            fmt_stop(stops[i + 1].1),
        ));
        if i > 0 {
            bounds.push(fmt_num(stops[i].0));
        }
        encode.push("0 1");
    }
    format!(
        "<< /FunctionType 3 /Domain [0 1] /Functions [{}] /Bounds [{}] /Encode [{}] >>",
        funcs.join(" "),
        bounds.join(" "),
        encode.join(" "),
    )
}

fn alpha_str(c: RgbaColor) -> String {
    fmt_color_comp(c.alpha)
}

/// 归一化并排序色标到 `[0, 1]`，返回 `(t_min, t_max, normalized_stops)`。
fn normalize_stops(mut raw: Vec<(f32, RgbaColor)>) -> Option<(f32, f32, Vec<(f32, RgbaColor)>)> {
    if raw.is_empty() {
        return None;
    }
    raw.sort_by(|a, b| a.0.total_cmp(&b.0));
    let t_min = raw[0].0;
    let t_max = raw[raw.len() - 1].0;
    let span = t_max - t_min;
    if span.abs() < 1e-6 {
        return Some((t_min, t_max, vec![(0.0, raw[raw.len() - 1].1)]));
    }
    let mut norm: Vec<(f32, RgbaColor)> = Vec::with_capacity(raw.len());
    for (t, c) in raw {
        let u = ((t - t_min) / span).clamp(0.0, 1.0);
        // 去掉与前一点偏移几乎重合的中间点，避免 PDF Type 3 Bounds 退化
        if let Some(last) = norm.last_mut() {
            if (u - last.0).abs() < 1e-4 {
                last.1 = c;
                continue;
            }
        }
        norm.push((u, c));
    }
    if norm.len() == 1 {
        return Some((t_min, t_max, norm));
    }
    // 确保首尾精确为 0 / 1
    norm[0].0 = 0.0;
    if let Some(last) = norm.last_mut() {
        last.0 = 1.0;
    }
    Some((t_min, t_max, norm))
}

struct PdfColrPainter<'a, 'b> {
    face: &'a Face<'a>,
    res: &'b mut Type3ResourceCollector,
    ops: String,
    pending_path: Option<String>,
    /// COLR v1 填充大矩形（字体单位），用于已被 clip 后的实色填充
    fill_extent: f32,
}

impl<'a, 'b> PdfColrPainter<'a, 'b> {
    fn new(face: &'a Face<'a>, res: &'b mut Type3ResourceCollector) -> Self {
        let upem = face.units_per_em().max(1) as f32;
        Self {
            face,
            res,
            ops: String::new(),
            pending_path: None,
            fill_extent: upem * 2.0,
        }
    }

    fn emit_solid(&mut self, color: RgbaColor) {
        if color.alpha == 0 {
            self.pending_path = None;
            return;
        }
        let has_alpha = color.alpha < 255;
        if has_alpha {
            let gs = self.res.intern_alpha(color.alpha);
            self.ops.push_str(&format!("q /{gs} gs\n"));
        }
        self.ops.push_str(&format!("{} rg\n", rgb_str(color)));
        if let Some(path) = self.pending_path.take() {
            if !path.is_empty() {
                self.ops.push_str(&path);
                self.ops.push_str("f\n");
            }
        } else {
            let e = self.fill_extent;
            self.ops.push_str(&format!(
                "{} {} {} {} re f\n",
                fmt_num(-e),
                fmt_num(-e),
                fmt_num(e * 2.0),
                fmt_num(e * 2.0),
            ));
        }
        if has_alpha {
            self.ops.push_str("Q\n");
        }
    }

    fn emit_shading_with_alpha(
        &mut self,
        shading_type: u8,
        coords: &str,
        stops: &[(f32, RgbaColor)],
    ) {
        let min_a = stops.iter().map(|s| s.1.alpha).min().unwrap_or(255);
        let max_a = stops.iter().map(|s| s.1.alpha).max().unwrap_or(255);
        if max_a == 0 {
            self.pending_path = None;
            return;
        }

        let color_func = build_gradient_function_with(stops, rgb_str);
        let color_dict = format!(
            "<< /ShadingType {shading_type} /ColorSpace /DeviceRGB /Coords [{coords}] /Function {color_func} /Extend [true true] >>",
        );
        let name = self.res.push_shading(color_dict);

        // 逐 stop alpha 不同时（如边缘阴影 0 -> 0.6），用同几何 DeviceGray Shading
        // 构 Luminosity SMask 精确还原渐隐，不把透明延展区蒙灰。
        let gs_name = if min_a != max_a {
            let alpha_func = build_gradient_function_with(stops, alpha_str);
            let alpha_dict = format!(
                "<< /ShadingType {shading_type} /ColorSpace /DeviceGray /Coords [{coords}] /Function {alpha_func} /Extend [true true] >>",
            );
            let e = self.fill_extent * 2.0;
            Some(self.res.push_soft_mask(alpha_dict, [-e, -e, e, e]))
        } else if max_a < 255 {
            Some(self.res.intern_alpha(max_a))
        } else {
            None
        };

        let pending = self.pending_path.take();
        let need_group = pending.is_some() || gs_name.is_some();
        if need_group {
            self.ops.push_str("q\n");
        }
        if let Some(path) = pending {
            if !path.is_empty() {
                self.ops.push_str(&path);
                self.ops.push_str("W n\n");
            }
        }
        if let Some(gs) = gs_name {
            self.ops.push_str(&format!("/{gs} gs\n"));
        }
        self.ops.push_str(&format!("/{name} sh\n"));
        if need_group {
            self.ops.push_str("Q\n");
        }
    }

    fn emit_linear(&mut self, lg: LinearGradient<'a>) {
        let raw: Vec<(f32, RgbaColor)> = lg
            .stops(0, &[])
            .map(|s| (s.stop_offset, s.color))
            .collect();
        let Some((t_min, t_max, stops)) = normalize_stops(raw) else {
            return;
        };
        if stops.len() == 1 {
            self.emit_solid(stops[0].1);
            return;
        }

        // OpenType COLR v1: p0→p2 为等色线方向，渐变轴是 p1-p0 在 p0→p2 法线上的投影。
        let dx2 = lg.x2 - lg.x0;
        let dy2 = lg.y2 - lg.y0;
        let len2 = dx2.hypot(dy2);
        let (p1x, p1y) = if len2 > 1e-6 {
            let nx = -dy2 / len2;
            let ny = dx2 / len2;
            let proj = (lg.x1 - lg.x0) * nx + (lg.y1 - lg.y0) * ny;
            (lg.x0 + proj * nx, lg.y0 + proj * ny)
        } else {
            (lg.x1, lg.y1)
        };

        let ax0 = lg.x0 + (p1x - lg.x0) * t_min;
        let ay0 = lg.y0 + (p1y - lg.y0) * t_min;
        let ax1 = lg.x0 + (p1x - lg.x0) * t_max;
        let ay1 = lg.y0 + (p1y - lg.y0) * t_max;

        let coords = format!(
            "{} {} {} {}",
            fmt_num(ax0),
            fmt_num(ay0),
            fmt_num(ax1),
            fmt_num(ay1),
        );
        self.emit_shading_with_alpha(2, &coords, &stops);
    }

    fn emit_radial(&mut self, rg: RadialGradient<'a>) {
        let raw: Vec<(f32, RgbaColor)> = rg
            .stops(0, &[])
            .map(|s| (s.stop_offset, s.color))
            .collect();
        let Some((t_min, t_max, stops)) = normalize_stops(raw) else {
            return;
        };
        if stops.len() == 1 {
            self.emit_solid(stops[0].1);
            return;
        }

        let cx0 = rg.x0 + (rg.x1 - rg.x0) * t_min;
        let cy0 = rg.y0 + (rg.y1 - rg.y0) * t_min;
        let cr0 = (rg.r0 + (rg.r1 - rg.r0) * t_min).max(0.0);
        let cx1 = rg.x0 + (rg.x1 - rg.x0) * t_max;
        let cy1 = rg.y0 + (rg.y1 - rg.y0) * t_max;
        let cr1 = (rg.r0 + (rg.r1 - rg.r0) * t_max).max(0.0);

        let coords = format!(
            "{} {} {} {} {} {}",
            fmt_num(cx0),
            fmt_num(cy0),
            fmt_num(cr0),
            fmt_num(cx1),
            fmt_num(cy1),
            fmt_num(cr1),
        );
        self.emit_shading_with_alpha(3, &coords, &stops);
    }
}

impl<'a> Painter<'a> for PdfColrPainter<'a, '_> {
    fn outline_glyph(&mut self, glyph_id: GlyphId) {
        let mut builder = PdfOutlineBuilder::new();
        self.face.outline_glyph(glyph_id, &mut builder);
        self.pending_path = Some(builder.ops);
    }

    fn paint(&mut self, paint: Paint<'a>) {
        match paint {
            Paint::Solid(color) => self.emit_solid(color),
            Paint::LinearGradient(lg) => self.emit_linear(lg),
            Paint::RadialGradient(rg) => self.emit_radial(rg),
            Paint::SweepGradient(sg) => {
                // PDF 无原生圆锥渐变，回退首个非透明 stop 实色
                if let Some(first) = sg.stops(0, &[]).next() {
                    self.emit_solid(first.color);
                } else {
                    self.pending_path = None;
                }
            }
        }
    }

    fn push_clip(&mut self) {
        self.ops.push_str("q\n");
        if let Some(path) = self.pending_path.take() {
            if !path.is_empty() {
                self.ops.push_str(&path);
                self.ops.push_str("W n\n");
                return;
            }
        }
        // 空轮廓：裁到零面积矩形，保持 q/Q 成对
        self.ops.push_str("0 0 0 0 re W n\n");
    }

    fn push_clip_box(&mut self, clipbox: ClipBox) {
        let w = (clipbox.x_max - clipbox.x_min).max(0.0);
        let h = (clipbox.y_max - clipbox.y_min).max(0.0);
        self.ops.push_str(&format!(
            "q\n{} {} {} {} re W n\n",
            fmt_num(clipbox.x_min),
            fmt_num(clipbox.y_min),
            fmt_num(w),
            fmt_num(h),
        ));
    }

    fn pop_clip(&mut self) {
        self.ops.push_str("Q\n");
    }

    fn push_layer(&mut self, _mode: CompositeMode) {
        self.ops.push_str("q\n");
    }

    fn pop_layer(&mut self) {
        self.ops.push_str("Q\n");
    }

    fn push_transform(&mut self, t: Transform) {
        self.ops.push_str(&format!(
            "q\n{} {} {} {} {} {} cm\n",
            fmt_num(t.a),
            fmt_num(t.b),
            fmt_num(t.c),
            fmt_num(t.d),
            fmt_num(t.e),
            fmt_num(t.f),
        ));
    }

    fn pop_transform(&mut self) {
        self.ops.push_str("Q\n");
    }
}

fn zlib_compress(data: &[u8]) -> Option<Vec<u8>> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data).ok()?;
    enc.finish().ok()
}

/// 解码 PNG 字节为 FlateDecode RGB + 可选 FlateDecode Gray SMask。
fn decode_png_to_flate_rgb_alpha(
    png_bytes: &[u8],
) -> Option<(u32, u32, Vec<u8>, Option<Vec<u8>>)> {
    let mut decoder = png::Decoder::new(png_bytes);
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let pixels = &buf[..info.buffer_size()];
    let width = info.width;
    let height = info.height;
    let count = (width as usize).checked_mul(height as usize)?;

    let mut rgb = Vec::with_capacity(count * 3);
    let mut alpha = Vec::with_capacity(count);
    let mut has_transparency = false;

    match info.color_type {
        png::ColorType::Rgba => {
            for px in pixels.chunks_exact(4) {
                rgb.extend_from_slice(&px[0..3]);
                alpha.push(px[3]);
                if px[3] < 255 {
                    has_transparency = true;
                }
            }
        }
        png::ColorType::Rgb => {
            rgb.extend_from_slice(pixels);
        }
        png::ColorType::GrayscaleAlpha => {
            for px in pixels.chunks_exact(2) {
                rgb.push(px[0]);
                rgb.push(px[0]);
                rgb.push(px[0]);
                alpha.push(px[1]);
                if px[1] < 255 {
                    has_transparency = true;
                }
            }
        }
        png::ColorType::Grayscale => {
            for &g in pixels {
                rgb.push(g);
                rgb.push(g);
                rgb.push(g);
            }
        }
        png::ColorType::Indexed => return None,
    }

    let rgb_flate = zlib_compress(&rgb)?;
    let alpha_flate = if has_transparency {
        Some(zlib_compress(&alpha)?)
    } else {
        None
    };
    Some((width, height, rgb_flate, alpha_flate))
}

/// 为单个彩色 `gid` 生成纯绘制算子（不含外层 `d0` 与 `1000/upem` 缩放，坐标为字体单位）。
fn build_color_glyph_body(
    face: &Face<'_>,
    gid: GlyphId,
    upem: u16,
    res: &mut Type3ResourceCollector,
    encode_b64: fn(&[u8]) -> String,
) -> Option<String> {
    // 1. 优先 COLR v0/v1 矢量
    if face.is_color_glyph(gid) {
        let mut painter = PdfColrPainter::new(face, res);
        let fg = RgbaColor::new(0, 0, 0, 255);
        if face.paint_color_glyph(gid, 0, fg, &mut painter).is_some() && !painter.ops.is_empty() {
            return Some(painter.ops);
        }
    }

    // 2. 其次 sbix / CBDT PNG 位图（macOS Apple Color Emoji / Linux Noto Color Emoji）
    if let Some(img) = face.glyph_raster_image(gid, 128) {
        if img.format == RasterImageFormat::PNG && !img.data.is_empty() {
            let (pw, ph, rgb_flate, alpha_flate) = decode_png_to_flate_rgb_alpha(img.data)?;
            let name = res.push_image(
                pw,
                ph,
                encode_b64(&rgb_flate),
                alpha_flate.as_deref().map(encode_b64),
            );
            let ppem = img.pixels_per_em.max(1) as f32;
            let fu_per_px = upem as f32 / ppem;
            let w_fu = pw as f32 * fu_per_px;
            let h_fu = ph as f32 * fu_per_px;
            let x_fu = img.x as f32 * fu_per_px;
            // sbix/CBDT 的 y 为基线相对偏移；若为负或 0（常见于 sbix originOffsetY）直接放左下角，
            // 若为正（常见于 CBDT bearingY = 顶边到基线距离）则底边 = y - h。
            let y_fu = if face.tables().sbix.is_some() {
                img.y as f32 * fu_per_px
            } else {
                (img.y as f32 - ph as f32) * fu_per_px
            };
            return Some(format!(
                "q {} 0 0 {} {} {} cm /{name} Do Q\n",
                fmt_num(w_fu),
                fmt_num(h_fu),
                fmt_num(x_fu),
                fmt_num(y_fu),
            ));
        }
    }

    None
}

/// 为单个彩色 `gid` 生成完整 Type3 CharProc 流（含 `w1000 0 d0` 与 `1000/upem` 缩放）。
pub fn build_color_char_proc(
    face: &Face<'_>,
    gid: GlyphId,
    w1000: u16,
    upem: u16,
    res: &mut Type3ResourceCollector,
    encode_b64: fn(&[u8]) -> String,
) -> Option<String> {
    let body = build_color_glyph_body(face, gid, upem, res, encode_b64)?;
    let scale = 1000.0 / (upem.max(1) as f32);
    Some(format!(
        "{w1000} 0 d0\n{s} 0 0 {s} 0 0 cm\n{body}",
        s = fmt_num(scale),
    ))
}

/// 为经过 HarfBuzz (rustybuzz) shaping 的多字形序列（ZWJ emoji / 国旗 / 肤色 / 按键序列等）
/// 合成单个 Type3 CharProc 流，支持单字形替换与多字形定位拼接。
pub fn build_shaped_color_char_proc(
    face: &Face<'_>,
    glyphs: &[(GlyphId, i32, i32, i32)], // (gid, x_offset, y_offset, x_advance) in font units
    w1000: u16,
    upem: u16,
    res: &mut Type3ResourceCollector,
    encode_b64: fn(&[u8]) -> String,
) -> Option<String> {
    if glyphs.is_empty() {
        return None;
    }
    let scale = 1000.0 / (upem.max(1) as f32);
    let mut out = format!(
        "{w1000} 0 d0\n{s} 0 0 {s} 0 0 cm\n",
        s = fmt_num(scale),
    );
    let mut cursor_x: i32 = 0;
    let mut any_drawn = false;
    for &(gid, x_off, y_off, x_adv) in glyphs {
        if let Some(body) = build_color_glyph_body(face, gid, upem, res, encode_b64) {
            let tx = cursor_x + x_off;
            let ty = y_off;
            if tx != 0 || ty != 0 {
                out.push_str(&format!(
                    "q 1 0 0 1 {} {} cm\n{body}Q\n",
                    fmt_num(tx as f32),
                    fmt_num(ty as f32),
                ));
            } else {
                out.push_str(&body);
            }
            any_drawn = true;
        }
        cursor_x += x_adv;
    }
    if any_drawn { Some(out) } else { None }
}
