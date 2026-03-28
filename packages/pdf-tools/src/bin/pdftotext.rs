use codepod_pdf_tools::{load_document, pages_in_range, print_help, print_version, EXIT_INPUT, EXIT_OK, EXIT_OUTPUT, EXIT_PERMISSION};
use std::io::Write as _;

fn parse_u32_option(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<u32, String> {
    let Some(value) = args.next() else {
        return Err(format!("pdftotext: option '{flag}' requires a number"));
    };
    value
        .parse::<u32>()
        .map_err(|_| format!("pdftotext: option '{flag}' requires a valid number"))
}

/// Return `<dir>/<stem>` (directory preserved) so the default output path
/// sits next to the input file, e.g. "/tmp/foo.pdf" → "/tmp/foo".
fn stem_path(path: &str) -> String {
    let p = std::path::Path::new(path);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    match p.parent() {
        Some(dir) if dir != std::path::Path::new("") => {
            format!("{}/{stem}", dir.to_string_lossy())
        }
        _ => stem,
    }
}

fn main() {
    let mut args = std::env::args().skip(1).peekable();
    let mut first: Option<u32> = None;
    let mut last: Option<u32> = None;
    let mut no_page_break = false;
    let mut input_path: Option<String> = None;
    let mut output_path: Option<String> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-f" => match parse_u32_option(&mut args, "-f") {
                Ok(value) => first = Some(value),
                Err(err) => {
                    eprintln!("{err}");
                    std::process::exit(EXIT_INPUT);
                }
            },
            "-l" => match parse_u32_option(&mut args, "-l") {
                Ok(value) => last = Some(value),
                Err(err) => {
                    eprintln!("{err}");
                    std::process::exit(EXIT_INPUT);
                }
            },
            "-nopgbrk" => no_page_break = true,
            // Accepted but ignored (layout mode requires full glyph positioning)
            "-layout" | "-raw" | "-fixed" | "-htmlmeta" | "-bbox" | "-bbox-layout" => {}
            // Accepted flags with value argument — consume and ignore
            "-enc" | "-eol" | "-opw" | "-upw" | "-r" | "-x" | "-y" | "-W" | "-H" | "-zoom" => {
                let _ = args.next();
            }
            "-q" => {}
            "-v" => {
                print_version("pdftotext");
                std::process::exit(EXIT_OK);
            }
            "-h" | "-help" | "--help" => {
                print_help(
                    "pdftotext [options] PDF-file [output-file]",
                    &[
                        "-f <number>      first page to extract",
                        "-l <number>      last page to extract",
                        "-layout          maintain original physical layout",
                        "-raw             keep strings in content stream order",
                        "-nopgbrk         don't insert page breaks between pages",
                        "-enc <encoding>  output text encoding (ignored)",
                        "-eol <type>      end-of-line convention (ignored)",
                        "-opw <password>  owner password (ignored)",
                        "-upw <password>  user password (ignored)",
                        "-q               quiet (no warnings/errors to stderr)",
                        "-v               print version info and exit",
                        "-h               print this usage information",
                    ],
                );
                std::process::exit(EXIT_OK);
            }
            // "-" alone means stdout (used as the output-file argument)
            "-" => {
                if input_path.is_none() {
                    // "-" as input is unusual; treat it as a positional
                    input_path = Some("-".to_string());
                } else {
                    output_path = Some("-".to_string());
                    break;
                }
            }
            other if other.starts_with('-') => {
                eprintln!("pdftotext: unsupported option '{other}'");
                std::process::exit(EXIT_INPUT);
            }
            other => {
                if input_path.is_none() {
                    input_path = Some(other.to_string());
                } else {
                    output_path = Some(other.to_string());
                    break;
                }
            }
        }
    }

    let Some(input_path) = input_path else {
        eprintln!("pdftotext: missing PDF-file");
        std::process::exit(EXIT_INPUT);
    };

    let doc = match load_document(&input_path) {
        Ok(doc) => doc,
        Err(err) => {
            eprintln!("pdftotext: {err}");
            std::process::exit(EXIT_INPUT);
        }
    };

    if doc.is_encrypted() {
        eprintln!("pdftotext: encrypted PDFs are not supported");
        std::process::exit(EXIT_PERMISSION);
    }

    let pages = doc.get_pages();
    let selected = pages_in_range(&pages, first, last);

    // Extract text per page using lopdf's built-in content-stream parser
    let mut page_texts: Vec<String> = Vec::with_capacity(selected.len());
    for (page_no, _) in &selected {
        let text = doc
            .extract_text(&[*page_no])
            .unwrap_or_default();
        page_texts.push(text);
    }

    // Build final output
    let mut output = String::new();
    let count = page_texts.len();
    for (i, text) in page_texts.into_iter().enumerate() {
        output.push_str(&text);
        // Ensure text ends with a newline before the page-break marker
        if !output.ends_with('\n') && !text.is_empty() {
            output.push('\n');
        }
        if !no_page_break {
            // Real pdftotext adds \f after every page including the last
            output.push('\x0c');
        } else if i + 1 < count {
            // With -nopgbrk, still separate pages with a newline if needed
            if !output.ends_with('\n') {
                output.push('\n');
            }
        }
    }

    // Determine output destination
    let use_stdout = output_path.as_deref() == Some("-");
    let default_out = format!("{}.txt", stem_path(&input_path));
    let out_path = if use_stdout {
        None
    } else {
        Some(output_path.unwrap_or(default_out))
    };

    if let Some(path) = out_path {
        if let Err(err) = std::fs::write(&path, output.as_bytes()) {
            eprintln!("pdftotext: error writing '{path}': {err}");
            std::process::exit(EXIT_OUTPUT);
        }
    } else {
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        if let Err(err) = out.write_all(output.as_bytes()) {
            eprintln!("pdftotext: write error: {err}");
            std::process::exit(EXIT_OUTPUT);
        }
    }
}
