//! sips — Scriptable Image Processing System
//!
//! A WASM-portable reimplementation of macOS `sips` backed by pil-rust-core.

use pil_rust_core::{self as pil, ImageHandle};
use std::env;
use std::fs;
use std::path::Path;
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        usage();
        process::exit(1);
    }

    let opts = Opts::parse(&args[1..]);

    if opts.input.is_none() {
        eprintln!("sips: no input file specified");
        process::exit(1);
    }

    let input_path = opts.input.as_ref().unwrap().clone();
    let bytes = match fs::read(&input_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("sips: {}: {e}", input_path);
            process::exit(1);
        }
    };

    let mut img = match pil::open(&bytes) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("sips: failed to decode {}: {e}", input_path);
            process::exit(1);
        }
    };

    // Query mode: -g property
    if !opts.get_props.is_empty() {
        for prop in &opts.get_props {
            print_property(&img, prop, &input_path);
        }
        return;
    }

    // Apply transformations in order
    let mut modified = false;

    if let Some((h, w)) = opts.resample_hw {
        img = pil::resize(&img, w, h, &opts.resample_filter);
        modified = true;
    }

    if let Some(max) = opts.resample_max {
        img = resize_to_fit(&img, max, &opts.resample_filter);
        modified = true;
    }

    if let Some(w) = opts.resample_width {
        let (ow, oh) = pil::size(&img);
        let h = (oh as f64 * w as f64 / ow as f64).round() as u32;
        img = pil::resize(&img, w, h, &opts.resample_filter);
        modified = true;
    }

    if let Some(h) = opts.resample_height {
        let (ow, oh) = pil::size(&img);
        let w = (ow as f64 * h as f64 / oh as f64).round() as u32;
        img = pil::resize(&img, w, h, &opts.resample_filter);
        modified = true;
    }

    if let Some(deg) = opts.rotate {
        img = pil::rotate(&img, deg);
        modified = true;
    }

    if let Some(ref dir) = opts.flip {
        img = flip(&img, dir);
        modified = true;
    }

    if let Some((ch, cw)) = opts.crop_hw {
        let (ox, oy) = opts.crop_offset.unwrap_or((0, 0));
        img = pil::crop(&img, ox, oy, cw, ch);
        modified = true;
    }

    if let Some((ph, pw)) = opts.pad_hw {
        img = pad_to(&img, pw, ph, &opts.pad_color);
        modified = true;
    }

    if let Some(ref fmt) = opts.set_format {
        // Format conversion counts as modification
        modified = true;
        let _ = fmt; // used below in save
    }

    if !modified && opts.set_format.is_none() {
        eprintln!("sips: no operations specified");
        process::exit(1);
    }

    // Determine output format
    let out_path = opts.output.as_deref().unwrap_or(&input_path);
    let format = opts
        .set_format
        .as_deref()
        .unwrap_or_else(|| format_from_path(out_path));

    let quality = opts.set_quality;
    let encoded = match pil::save_with_options(&img, format, quality) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("sips: failed to encode as {format}: {e}");
            process::exit(1);
        }
    };

    if let Err(e) = fs::write(out_path, &encoded) {
        eprintln!("sips: {out_path}: {e}");
        process::exit(1);
    }
}

// ---------------------------------------------------------------------------
// Property queries
// ---------------------------------------------------------------------------

fn print_property(img: &ImageHandle, prop: &str, path: &str) {
    let (w, h) = pil::size(img);
    match prop {
        "pixelWidth" => println!("  pixelWidth: {w}"),
        "pixelHeight" => println!("  pixelHeight: {h}"),
        "pixelCount" => println!("  pixelCount: {}", w as u64 * h as u64),
        "format" => println!("  format: {}", pil::mode(img)),
        "space" => println!("  space: {}", color_space(img)),
        "bitsPerSample" => println!("  bitsPerSample: {}", bits_per_sample(img)),
        "hasAlpha" => println!("  hasAlpha: {}", has_alpha(img)),
        "all" => {
            println!("{}:", path);
            println!("  pixelWidth: {w}");
            println!("  pixelHeight: {h}");
            println!("  format: {}", pil::mode(img));
            println!("  space: {}", color_space(img));
            println!("  bitsPerSample: {}", bits_per_sample(img));
            println!("  hasAlpha: {}", has_alpha(img));
        }
        _ => eprintln!("sips: unknown property: {prop}"),
    }
}

fn color_space(img: &ImageHandle) -> &'static str {
    match pil::mode(img) {
        "L" | "LA" => "Gray",
        "RGB" | "RGBA" => "RGB",
        "I;16" | "LA;16" => "Gray",
        "RGB;16" | "RGBA;16" => "RGB",
        "RGB;32F" | "RGBA;32F" => "RGB",
        _ => "RGB",
    }
}

fn bits_per_sample(img: &ImageHandle) -> u32 {
    match pil::mode(img) {
        "I;16" | "LA;16" | "RGB;16" | "RGBA;16" => 16,
        "RGB;32F" | "RGBA;32F" => 32,
        _ => 8,
    }
}

fn has_alpha(img: &ImageHandle) -> bool {
    matches!(pil::mode(img), "RGBA" | "LA" | "LA;16" | "RGBA;16" | "RGBA;32F")
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

fn resize_to_fit(img: &ImageHandle, max: u32, filter: &str) -> ImageHandle {
    let (w, h) = pil::size(img);
    if w <= max && h <= max {
        return img.clone();
    }
    let scale = (max as f64 / w as f64).min(max as f64 / h as f64);
    let nw = (w as f64 * scale).round() as u32;
    let nh = (h as f64 * scale).round() as u32;
    pil::resize(img, nw, nh, filter)
}

fn flip(img: &ImageHandle, direction: &str) -> ImageHandle {
    match direction {
        "horizontal" => pil::transpose(img, 0).unwrap(),
        "vertical" => pil::transpose(img, 1).unwrap(),
        _ => {
            eprintln!("sips: unknown flip direction: {direction}");
            img.clone()
        }
    }
}

fn pad_to(img: &ImageHandle, tw: u32, th: u32, color: &[u8; 4]) -> ImageHandle {
    let (w, h) = pil::size(img);
    if w >= tw && h >= th {
        return img.clone();
    }
    let pw = tw.max(w);
    let ph = th.max(h);
    let mode_str = pil::mode(img);
    let mut canvas = pil::new_image(mode_str, pw, ph, color).unwrap();
    let ox = ((pw - w) / 2) as i32;
    let oy = ((ph - h) / 2) as i32;
    pil::paste(&mut canvas, img, ox, oy, None);
    canvas
}

fn format_from_path(path: &str) -> &str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "jpeg",
        Some("png") => "png",
        Some("gif") => "gif",
        Some("bmp") => "bmp",
        Some("tiff" | "tif") => "tiff",
        Some("webp") => "webp",
        _ => "png",
    }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

struct Opts {
    get_props: Vec<String>,
    resample_hw: Option<(u32, u32)>,
    resample_max: Option<u32>,
    resample_width: Option<u32>,
    resample_height: Option<u32>,
    resample_filter: String,
    rotate: Option<f32>,
    flip: Option<String>,
    crop_hw: Option<(u32, u32)>,
    crop_offset: Option<(u32, u32)>,
    pad_hw: Option<(u32, u32)>,
    pad_color: [u8; 4],
    set_format: Option<String>,
    set_quality: Option<u8>,
    output: Option<String>,
    input: Option<String>,
}

impl Opts {
    fn parse(args: &[String]) -> Self {
        let mut opts = Opts {
            get_props: Vec::new(),
            resample_hw: None,
            resample_max: None,
            resample_width: None,
            resample_height: None,
            resample_filter: "lanczos".into(),
            rotate: None,
            flip: None,
            crop_hw: None,
            crop_offset: None,
            pad_hw: None,
            pad_color: [0, 0, 0, 255],
            set_format: None,
            set_quality: None,
            output: None,
            input: None,
        };

        let mut i = 0;
        while i < args.len() {
            let a = &args[i];
            match a.as_str() {
                "-g" | "--getProperty" => {
                    i += 1;
                    if i < args.len() {
                        opts.get_props.push(args[i].clone());
                    }
                }
                "-s" | "--setProperty" => {
                    i += 1;
                    if i + 1 < args.len() {
                        let key = &args[i];
                        i += 1;
                        let val = &args[i];
                        match key.as_str() {
                            "format" | "formatOptions" => {
                                opts.set_format = Some(val.clone());
                            }
                            "formatOptions.quality" => {
                                opts.set_quality = val.parse().ok();
                            }
                            _ => eprintln!("sips: unknown property to set: {key}"),
                        }
                    }
                }
                "-z" | "--resampleHeightWidth" => {
                    if i + 2 < args.len() {
                        let h: u32 = args[i + 1].parse().unwrap_or(0);
                        let w: u32 = args[i + 2].parse().unwrap_or(0);
                        opts.resample_hw = Some((h, w));
                        i += 2;
                    }
                }
                "-Z" | "--resampleHeightWidthMax" => {
                    i += 1;
                    if i < args.len() {
                        opts.resample_max = args[i].parse().ok();
                    }
                }
                "--resampleWidth" => {
                    i += 1;
                    if i < args.len() {
                        opts.resample_width = args[i].parse().ok();
                    }
                }
                "--resampleHeight" => {
                    i += 1;
                    if i < args.len() {
                        opts.resample_height = args[i].parse().ok();
                    }
                }
                "--resampleFilter" => {
                    i += 1;
                    if i < args.len() {
                        opts.resample_filter = args[i].clone();
                    }
                }
                "-r" | "--rotate" => {
                    i += 1;
                    if i < args.len() {
                        opts.rotate = args[i].parse().ok();
                    }
                }
                "-f" | "--flip" => {
                    i += 1;
                    if i < args.len() {
                        opts.flip = Some(args[i].clone());
                    }
                }
                "-c" | "--cropToHeightWidth" => {
                    if i + 2 < args.len() {
                        let h: u32 = args[i + 1].parse().unwrap_or(0);
                        let w: u32 = args[i + 2].parse().unwrap_or(0);
                        opts.crop_hw = Some((h, w));
                        i += 2;
                    }
                }
                "--cropOffset" => {
                    if i + 2 < args.len() {
                        let x: u32 = args[i + 1].parse().unwrap_or(0);
                        let y: u32 = args[i + 2].parse().unwrap_or(0);
                        opts.crop_offset = Some((x, y));
                        i += 2;
                    }
                }
                "-p" | "--padToHeightWidth" => {
                    if i + 2 < args.len() {
                        let h: u32 = args[i + 1].parse().unwrap_or(0);
                        let w: u32 = args[i + 2].parse().unwrap_or(0);
                        opts.pad_hw = Some((h, w));
                        i += 2;
                    }
                }
                "--padColor" => {
                    i += 1;
                    if i < args.len() {
                        opts.pad_color = parse_hex_color(&args[i]);
                    }
                }
                "-o" | "--out" => {
                    i += 1;
                    if i < args.len() {
                        opts.output = Some(args[i].clone());
                    }
                }
                "-h" | "--help" => {
                    usage();
                    process::exit(0);
                }
                _ => {
                    if !a.starts_with('-') {
                        opts.input = Some(a.clone());
                    } else {
                        eprintln!("sips: unknown option: {a}");
                        process::exit(1);
                    }
                }
            }
            i += 1;
        }

        opts
    }
}

fn parse_hex_color(s: &str) -> [u8; 4] {
    let s = s.trim_start_matches('#');
    let r = u8::from_str_radix(s.get(0..2).unwrap_or("00"), 16).unwrap_or(0);
    let g = u8::from_str_radix(s.get(2..4).unwrap_or("00"), 16).unwrap_or(0);
    let b = u8::from_str_radix(s.get(4..6).unwrap_or("00"), 16).unwrap_or(0);
    let a = u8::from_str_radix(s.get(6..8).unwrap_or("FF"), 16).unwrap_or(255);
    [r, g, b, a]
}

fn usage() {
    eprintln!(
        "\
sips - Scriptable Image Processing System

Usage:
  sips [options] <input>

Query:
  -g <property>              Get property (pixelWidth, pixelHeight, format,
                             space, bitsPerSample, hasAlpha, all)

Transforms:
  -z <height> <width>        Resample to exact height x width
  -Z <maxdim>               Resample to fit within max dimension
  --resampleWidth <w>        Resample to width, preserving aspect ratio
  --resampleHeight <h>       Resample to height, preserving aspect ratio
  --resampleFilter <f>       Filter: lanczos (default), nearest, linear,
                             cubic, gaussian
  -r, --rotate <degrees>     Rotate counter-clockwise
  -f, --flip <direction>     Flip: horizontal, vertical
  -c <height> <width>        Crop to height x width
  --cropOffset <x> <y>       Crop origin offset (default: 0 0)
  -p <height> <width>        Pad to height x width (centers image)
  --padColor <RRGGBB>        Pad fill color (default: 000000)

Output:
  -s format <fmt>            Set output format: jpeg, png, gif, bmp, tiff, webp
  -s formatOptions.quality <n>  JPEG quality (1-100)
  -o, --out <path>           Output path (default: overwrite input)"
    );
}
