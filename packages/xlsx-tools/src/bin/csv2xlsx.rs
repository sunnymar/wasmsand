use codepod_xlsx_tools::{
    print_help, print_version, read_input_csv, EXIT_INPUT, EXIT_OK, EXIT_OUTPUT,
};
use csv::StringRecord;
use rust_xlsxwriter::Workbook;

fn main() {
    let mut args = std::env::args().skip(1).peekable();
    let mut input_path: Option<String> = None;
    let mut workbook_path: Option<String> = None;
    let mut worksheet_name: Option<String> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-i" => input_path = args.next(),
            "-v" | "-version" => {
                print_version("csv2xlsx");
                std::process::exit(EXIT_OK);
            }
            "-h" | "-help" | "--help" => {
                print_help(
                    "csv2xlsx [-i CSV] WORKBOOK_PATH WORKSHEET_NAME",
                    &["-i <path>", "-v, -version", "-h, -help, --help"],
                );
                std::process::exit(EXIT_OK);
            }
            other if other.starts_with('-') => {
                eprintln!("csv2xlsx: unsupported option '{other}'");
                std::process::exit(EXIT_INPUT);
            }
            other => {
                workbook_path = Some(other.to_string());
                worksheet_name = args.next();
                break;
            }
        }
    }

    let (Some(workbook_path), Some(worksheet_name)) = (workbook_path, worksheet_name) else {
        eprintln!("csv2xlsx: expected WORKBOOK_PATH and WORKSHEET_NAME");
        std::process::exit(EXIT_INPUT);
    };

    let csv_input = match read_input_csv(input_path.as_deref()) {
        Ok(input) => input,
        Err(err) => {
            eprintln!("csv2xlsx: {err}");
            std::process::exit(EXIT_INPUT);
        }
    };

    if csv_input.is_empty() {
        eprintln!("csv2xlsx: no CSV input provided");
        std::process::exit(EXIT_INPUT);
    }

    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(csv_input.as_bytes());

    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet().set_name(&worksheet_name);
    let worksheet = match worksheet {
        Ok(worksheet) => worksheet,
        Err(err) => {
            eprintln!("csv2xlsx: invalid worksheet name '{worksheet_name}': {err}");
            std::process::exit(EXIT_INPUT);
        }
    };

    for (row_idx, record) in reader.records().enumerate() {
        let record: StringRecord = match record {
            Ok(record) => record,
            Err(err) => {
                eprintln!("csv2xlsx: failed to parse CSV: {err}");
                std::process::exit(EXIT_INPUT);
            }
        };
        for (col_idx, value) in record.iter().enumerate() {
            if let Err(err) = worksheet.write(row_idx as u32, col_idx as u16, value) {
                eprintln!("csv2xlsx: failed to write cell: {err}");
                std::process::exit(EXIT_OUTPUT);
            }
        }
    }

    if let Err(err) = workbook.save(&workbook_path) {
        eprintln!("csv2xlsx: failed to save '{workbook_path}': {err}");
        std::process::exit(EXIT_OUTPUT);
    }
}
