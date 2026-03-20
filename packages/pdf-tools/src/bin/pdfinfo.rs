use codepod_pdf_tools::{
    info_output, load_document, print_help, print_version, EXIT_INPUT, EXIT_OK, EXIT_PERMISSION,
};

fn parse_u32_option(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<u32, String> {
    let Some(value) = args.next() else {
        return Err(format!("pdfinfo: option '{flag}' requires a number"));
    };
    value
        .parse::<u32>()
        .map_err(|_| format!("pdfinfo: option '{flag}' requires a valid number"))
}

fn main() {
    let mut args = std::env::args().skip(1).peekable();
    let mut first = None;
    let mut last = None;
    let mut show_boxes = false;
    let mut show_meta = false;
    let mut input_path = None;

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
            "-box" => show_boxes = true,
            "-meta" => show_meta = true,
            "-isodates" | "-rawdates" => {}
            "-enc" | "-opw" | "-upw" => {
                let _ = args.next();
            }
            "-v" => {
                print_version("pdfinfo");
                std::process::exit(EXIT_OK);
            }
            "-h" | "-help" | "--help" => {
                print_help(
                    "pdfinfo [options] PDF-file",
                    &[
                        "-f <number>",
                        "-l <number>",
                        "-box",
                        "-meta",
                        "-isodates",
                        "-rawdates",
                        "-enc <encoding-name>",
                        "-opw <password>",
                        "-upw <password>",
                        "-v",
                        "-h, -help, --help",
                    ],
                );
                std::process::exit(EXIT_OK);
            }
            other if other.starts_with('-') => {
                eprintln!("pdfinfo: unsupported option '{other}'");
                std::process::exit(EXIT_INPUT);
            }
            other => {
                input_path = Some(other.to_string());
                break;
            }
        }
    }

    let Some(input_path) = input_path else {
        eprintln!("pdfinfo: missing PDF-file");
        std::process::exit(EXIT_INPUT);
    };

    let doc = match load_document(&input_path) {
        Ok(doc) => doc,
        Err(err) => {
            eprintln!("pdfinfo: {err}");
            std::process::exit(EXIT_INPUT);
        }
    };

    if doc.is_encrypted() {
        eprintln!("pdfinfo: encrypted PDFs are not supported in v1");
        std::process::exit(EXIT_PERMISSION);
    }

    print!(
        "{}",
        info_output(&doc, &input_path, first, last, show_boxes, show_meta)
    );
}
