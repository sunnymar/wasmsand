use codepod_pdf_tools::{
    extract_page_to_document, load_document, print_help, print_version, save_document, EXIT_INPUT,
    EXIT_OK, EXIT_OUTPUT,
};

fn render_pattern(pattern: &str, page_no: u32) -> Option<String> {
    if pattern.contains("%d") {
        return Some(pattern.replacen("%d", &page_no.to_string(), 1));
    }
    None
}

fn main() {
    let mut args = std::env::args().skip(1).peekable();
    let mut first = None;
    let mut last = None;
    let mut input_path = None;
    let mut pattern = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-f" => first = args.next().and_then(|v| v.parse::<u32>().ok()),
            "-l" => last = args.next().and_then(|v| v.parse::<u32>().ok()),
            "-v" => {
                print_version("pdfseparate");
                std::process::exit(EXIT_OK);
            }
            "-h" | "-help" | "--help" => {
                print_help(
                    "pdfseparate [options] PDF-file PDF-page-pattern",
                    &["-f <number>", "-l <number>", "-v", "-h, -help, --help"],
                );
                std::process::exit(EXIT_OK);
            }
            other if other.starts_with('-') => {
                eprintln!("pdfseparate: unsupported option '{other}'");
                std::process::exit(EXIT_INPUT);
            }
            other => {
                input_path = Some(other.to_string());
                pattern = args.next();
                break;
            }
        }
    }

    let (Some(input_path), Some(pattern)) = (input_path, pattern) else {
        eprintln!("pdfseparate: expected PDF-file and PDF-page-pattern");
        std::process::exit(EXIT_INPUT);
    };

    if !pattern.contains("%d") {
        eprintln!("pdfseparate: output pattern must contain %d");
        std::process::exit(EXIT_INPUT);
    }

    let doc = match load_document(&input_path) {
        Ok(doc) => doc,
        Err(err) => {
            eprintln!("pdfseparate: {err}");
            std::process::exit(EXIT_INPUT);
        }
    };

    let pages = doc.get_pages();
    let start = first.unwrap_or(1);
    let end = last.unwrap_or_else(|| pages.keys().next_back().copied().unwrap_or(0));

    for page_no in start..=end {
        let Some(output_path) = render_pattern(&pattern, page_no) else {
            eprintln!("pdfseparate: invalid output pattern");
            std::process::exit(EXIT_INPUT);
        };
        let mut page_doc = match extract_page_to_document(&doc, page_no) {
            Ok(doc) => doc,
            Err(err) => {
                eprintln!("pdfseparate: failed to extract page {page_no}: {err}");
                std::process::exit(EXIT_OUTPUT);
            }
        };
        if let Err(err) = save_document(&mut page_doc, &output_path) {
            eprintln!("pdfseparate: failed to extract page {page_no}: {err}");
            std::process::exit(EXIT_OUTPUT);
        }
    }
}
