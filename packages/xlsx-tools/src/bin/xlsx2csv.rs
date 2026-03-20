use calamine::Reader;
use codepod_xlsx_tools::{
    csv_writer_to, data_to_string, load_workbook, print_help, print_version, EXIT_INPUT, EXIT_OK,
    EXIT_OUTPUT,
};

fn main() {
    let mut args = std::env::args().skip(1).peekable();
    let mut list_sheets = false;
    let mut count_only = false;
    let mut add_newline = false;
    let mut use_crlf = false;
    let mut output_path: Option<String> = None;
    let mut quiet = false;
    let mut workbook_path: Option<String> = None;
    let mut sheet_name: Option<String> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-N" | "-sheets" => list_sheets = true,
            "-c" | "-count" => count_only = true,
            "-nl" | "-newline" => add_newline = true,
            "-crlf" => use_crlf = true,
            "-o" | "-output" => output_path = args.next(),
            "-quiet" => quiet = true,
            "-version" => {
                print_version("xlsx2csv");
                std::process::exit(EXIT_OK);
            }
            "-help" | "-h" | "--help" => {
                print_help(
                    "xlsx2csv [OPTIONS] EXCEL_WORKBOOK_NAME [SHEET_NAME]",
                    &[
                        "-N, -sheets",
                        "-c, -count",
                        "-nl, -newline",
                        "-crlf",
                        "-o, -output <path>",
                        "-quiet",
                        "-version",
                        "-help",
                    ],
                );
                std::process::exit(EXIT_OK);
            }
            other if other.starts_with('-') => {
                if !quiet {
                    eprintln!("xlsx2csv: unsupported option '{other}'");
                }
                std::process::exit(EXIT_INPUT);
            }
            other => {
                workbook_path = Some(other.to_string());
                sheet_name = args.next();
                break;
            }
        }
    }

    let Some(workbook_path) = workbook_path else {
        if !quiet {
            eprintln!("xlsx2csv: missing workbook path");
        }
        std::process::exit(EXIT_INPUT);
    };

    let mut workbook = match load_workbook(&workbook_path) {
        Ok(workbook) => workbook,
        Err(err) => {
            if !quiet {
                eprintln!("xlsx2csv: {err}");
            }
            std::process::exit(EXIT_INPUT);
        }
    };

    let sheets = workbook.sheet_names().to_vec();

    if count_only {
        println!("{}", sheets.len());
        std::process::exit(EXIT_OK);
    }
    if list_sheets {
        for sheet in sheets {
            println!("{sheet}");
        }
        std::process::exit(EXIT_OK);
    }

    let selected = match sheet_name {
        Some(name) => name,
        None => match sheets.first() {
            Some(name) => name.clone(),
            None => {
                if !quiet {
                    eprintln!("xlsx2csv: workbook contains no sheets");
                }
                std::process::exit(EXIT_INPUT);
            }
        },
    };

    let range = match workbook.worksheet_range(&selected) {
        Ok(range) => range,
        Err(err) => {
            if !quiet {
                eprintln!("xlsx2csv: failed to read worksheet '{selected}': {err}");
            }
            std::process::exit(EXIT_INPUT);
        }
    };

    let output_to_stdout = output_path.as_deref().unwrap_or("-") == "-";
    let write_result = if output_to_stdout {
        let stdout = std::io::stdout();
        let mut writer = csv_writer_to(stdout.lock(), use_crlf);
        for row in range.rows() {
            let values: Vec<String> = row.iter().map(data_to_string).collect();
            if let Err(err) = writer.write_record(values) {
                if !quiet {
                    eprintln!("xlsx2csv: failed to write CSV: {err}");
                }
                std::process::exit(EXIT_OUTPUT);
            }
        }
        writer.flush()
    } else {
        let file = match std::fs::File::create(output_path.as_deref().unwrap()) {
            Ok(file) => file,
            Err(err) => {
                if !quiet {
                    eprintln!(
                        "xlsx2csv: failed to create '{}': {err}",
                        output_path.as_deref().unwrap()
                    );
                }
                std::process::exit(EXIT_OUTPUT);
            }
        };
        let mut writer = csv_writer_to(file, use_crlf);
        for row in range.rows() {
            let values: Vec<String> = row.iter().map(data_to_string).collect();
            if let Err(err) = writer.write_record(values) {
                if !quiet {
                    eprintln!("xlsx2csv: failed to write CSV: {err}");
                }
                std::process::exit(EXIT_OUTPUT);
            }
        }
        writer.flush()
    };

    if let Err(err) = write_result {
        if !quiet {
            eprintln!("xlsx2csv: failed to finalize CSV output: {err}");
        }
        std::process::exit(EXIT_OUTPUT);
    }

    if add_newline && !output_to_stdout {
        use std::io::Write as _;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .append(true)
            .open(output_path.as_deref().unwrap())
        {
            let _ = if use_crlf {
                file.write_all(b"\r\n")
            } else {
                file.write_all(b"\n")
            };
        }
    }
}
