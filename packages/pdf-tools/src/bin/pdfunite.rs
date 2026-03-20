use codepod_pdf_tools::{
    load_document, merge_documents, print_help, print_version, save_document, EXIT_INPUT, EXIT_OK,
};

fn main() {
    let mut positionals = Vec::new();

    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "-v" => {
                print_version("pdfunite");
                std::process::exit(EXIT_OK);
            }
            "-h" | "-help" | "--help" => {
                print_help(
                    "pdfunite [options] PDF-sourcefile1 ... PDF-sourcefileN PDF-destfile",
                    &["-v", "-h, -help, --help"],
                );
                std::process::exit(EXIT_OK);
            }
            other if other.starts_with('-') => {
                eprintln!("pdfunite: unsupported option '{other}'");
                std::process::exit(EXIT_INPUT);
            }
            other => positionals.push(other.to_string()),
        }
    }

    if positionals.len() < 3 {
        eprintln!("pdfunite: expected at least two input PDFs and one output path");
        std::process::exit(EXIT_INPUT);
    }

    let output_path = positionals.pop().unwrap();
    let input_paths = positionals;

    let mut docs = Vec::new();
    for path in &input_paths {
        match load_document(path) {
            Ok(doc) => docs.push(doc),
            Err(err) => {
                eprintln!("pdfunite: {err}");
                std::process::exit(EXIT_INPUT);
            }
        }
    }

    let mut merged = match merge_documents(docs) {
        Ok(doc) => doc,
        Err(err) => {
            eprintln!("pdfunite: failed to merge PDF: {err}");
            std::process::exit(EXIT_INPUT);
        }
    };

    if let Err(err) = save_document(&mut merged, &output_path) {
        eprintln!("pdfunite: {err}");
        std::process::exit(codepod_pdf_tools::EXIT_OUTPUT);
    }
}
