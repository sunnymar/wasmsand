use codepod_pdf_tools::{
    load_document, pages_in_range, print_help, print_version, EXIT_INPUT, EXIT_OK, EXIT_OTHER,
    EXIT_OUTPUT, EXIT_PERMISSION,
};
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

fn print_usage() {
    print_help(
        "pdftotext [options] <PDF-file> [<text-file>]",
        &[
            "-f <int>             : first page to convert",
            "-l <int>             : last page to convert",
            "-layout              : maintain original physical layout",
            "-raw                 : keep strings in content stream order",
            "-nopgbrk             : don't insert page breaks between pages",
            "-nodiag              : discard diagonal text (ignored)",
            "-htmlmeta            : generate a simple HTML file (ignored)",
            "-tsv                 : generate a simple TSV file (ignored)",
            "-enc <string>        : output text encoding name (ignored)",
            "-eol <string>        : output end-of-line convention (ignored)",
            "-bbox                : output bounding box info (ignored)",
            "-bbox-layout         : like -bbox with layout data (ignored)",
            "-cropbox             : use the crop box (ignored)",
            "-colspacing <fp>     : column spacing fraction (ignored)",
            "-opw <string>        : owner password (for encrypted files)",
            "-upw <string>        : user password (for encrypted files)",
            "-q                   : don't print any messages or errors",
            "-v                   : print copyright and version info",
            "-h                   : print usage information",
            "-help                : print usage information",
            "--help               : print usage information",
        ],
    );
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
            // Accepted but ignored (layout requires full glyph positioning)
            "-layout" | "-raw" | "-nodiag" | "-htmlmeta" | "-tsv"
            | "-bbox" | "-bbox-layout" | "-cropbox" | "-q" | "-listenc" => {}
            // Accepted flags that take a value argument — consume and ignore
            "-enc" | "-eol" | "-opw" | "-upw" | "-r" | "-x" | "-y" | "-W" | "-H"
            | "-zoom" | "-fixed" | "-colspacing" => {
                let _ = args.next();
            }
            "-v" => {
                // Poppler sends version to stderr
                print_version("pdftotext");
                std::process::exit(EXIT_OK);
            }
            "-h" | "-help" | "--help" => {
                // Poppler sends help to stderr, exits 0
                print_usage();
                std::process::exit(EXIT_OK);
            }
            // "-" alone means stdout as the output-file argument
            "-" => {
                if input_path.is_none() {
                    input_path = Some("-".to_string());
                } else {
                    output_path = Some("-".to_string());
                    break;
                }
            }
            other if other.starts_with('-') => {
                // Poppler: unrecognized option is treated as the PDF filename.
                // We match that: stop option parsing, treat as positional.
                if input_path.is_none() {
                    input_path = Some(other.to_string());
                } else {
                    output_path = Some(other.to_string());
                    break;
                }
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
        // Poppler: no args → print help to stderr and exit 99
        print_usage();
        std::process::exit(EXIT_OTHER);
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
        let text = doc.extract_text(&[*page_no]).unwrap_or_default();
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
            // pdftotext adds \f after every page including the last
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
