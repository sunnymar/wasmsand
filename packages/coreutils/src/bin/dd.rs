//! dd - convert and copy a file

use std::env;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::process;

enum Output {
    File(File),
    Stdout(io::Stdout),
}

impl Write for Output {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Output::File(f) => f.write(buf),
            Output::Stdout(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Output::File(f) => f.flush(),
            Output::Stdout(s) => s.flush(),
        }
    }
}

struct DdOptions {
    input_file: Option<String>,
    output_file: Option<String>,
    ibs: usize,
    obs: usize,
    count: Option<usize>,
    skip: usize,
    seek: usize,
    conv_ucase: bool,
    conv_lcase: bool,
    conv_notrunc: bool,
    status_none: bool,
}

fn parse_size(s: &str) -> Result<usize, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("empty size".to_string());
    }

    // Try suffixes from longest to shortest
    let suffixes: &[(&str, usize)] = &[
        ("GB", 1_000_000_000),
        ("MB", 1_000_000),
        ("kB", 1_000),
        ("G", 1 << 30),
        ("M", 1 << 20),
        ("k", 1 << 10),
        ("K", 1 << 10),
    ];

    for &(suffix, mult) in suffixes {
        if let Some(prefix) = s.strip_suffix(suffix) {
            let n: usize = prefix
                .parse()
                .map_err(|_| format!("invalid number: '{s}'"))?;
            return Ok(n * mult);
        }
    }

    s.parse::<usize>()
        .map_err(|_| format!("invalid number: '{s}'"))
}

fn parse_args() -> Result<DdOptions, String> {
    let mut opts = DdOptions {
        input_file: None,
        output_file: None,
        ibs: 512,
        obs: 512,
        count: None,
        skip: 0,
        seek: 0,
        conv_ucase: false,
        conv_lcase: false,
        conv_notrunc: false,
        status_none: false,
    };

    let mut bs_set = false;

    for arg in env::args().skip(1) {
        if let Some((key, val)) = arg.split_once('=') {
            match key {
                "if" => opts.input_file = Some(val.to_string()),
                "of" => opts.output_file = Some(val.to_string()),
                "bs" => {
                    let size = parse_size(val)?;
                    opts.ibs = size;
                    opts.obs = size;
                    bs_set = true;
                }
                "ibs" => {
                    if !bs_set {
                        opts.ibs = parse_size(val)?;
                    }
                }
                "obs" => {
                    if !bs_set {
                        opts.obs = parse_size(val)?;
                    }
                }
                "count" => opts.count = Some(parse_size(val)?),
                "skip" => opts.skip = parse_size(val)?,
                "seek" => opts.seek = parse_size(val)?,
                "status" => {
                    if val == "none" {
                        opts.status_none = true;
                    }
                }
                "conv" => {
                    for flag in val.split(',') {
                        match flag.trim() {
                            "ucase" => opts.conv_ucase = true,
                            "lcase" => opts.conv_lcase = true,
                            "notrunc" => opts.conv_notrunc = true,
                            other => return Err(format!("dd: unknown conv flag: '{other}'")),
                        }
                    }
                }
                _ => return Err(format!("dd: unrecognized operand '{key}'")),
            }
        } else if arg == "--help" {
            eprintln!("Usage: dd [OPERAND]...");
            eprintln!("Operands: if, of, bs, ibs, obs, count, skip, seek, conv, status");
            process::exit(0);
        } else {
            return Err(format!("dd: unrecognized operand '{arg}'"));
        }
    }

    Ok(opts)
}

fn run() -> i32 {
    let opts = match parse_args() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };

    let mut input: Box<dyn Read> = match &opts.input_file {
        Some(path) => match File::open(path) {
            Ok(f) => Box::new(f),
            Err(e) => {
                eprintln!("dd: failed to open '{}': {}", path, e);
                return 1;
            }
        },
        None => Box::new(io::stdin()),
    };

    let mut output: Output = match &opts.output_file {
        Some(path) => {
            let file = if opts.conv_notrunc {
                OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(path)
            } else {
                OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .open(path)
            };
            match file {
                Ok(f) => Output::File(f),
                Err(e) => {
                    eprintln!("dd: failed to open '{}': {}", path, e);
                    return 1;
                }
            }
        }
        None => Output::Stdout(io::stdout()),
    };

    // Skip input blocks
    if opts.skip > 0 {
        let mut skip_buf = vec![0u8; opts.ibs];
        for _ in 0..opts.skip {
            if let Err(e) = read_full(&mut input, &mut skip_buf) {
                eprintln!("dd: skip error: {e}");
                return 1;
            }
        }
    }

    // Seek output blocks
    if opts.seek > 0 {
        let seek_bytes = (opts.seek * opts.obs) as u64;
        match &mut output {
            Output::File(f) => {
                if let Err(e) = f.seek(SeekFrom::Start(seek_bytes)) {
                    eprintln!("dd: seek error: {e}");
                    return 1;
                }
            }
            Output::Stdout(_) => {
                let zeros = vec![0u8; opts.obs];
                for _ in 0..opts.seek {
                    if let Err(e) = output.write_all(&zeros) {
                        eprintln!("dd: seek write error: {e}");
                        return 1;
                    }
                }
            }
        }
    }

    let mut in_buf = vec![0u8; opts.ibs];
    let mut full_records_in: u64 = 0;
    let mut partial_records_in: u64 = 0;
    let mut full_records_out: u64 = 0;
    let mut partial_records_out: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut blocks_read: usize = 0;

    loop {
        if let Some(count) = opts.count {
            if blocks_read >= count {
                break;
            }
        }

        let n = match input.read(&mut in_buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                eprintln!("dd: read error: {e}");
                return 1;
            }
        };
        blocks_read += 1;

        if n == opts.ibs {
            full_records_in += 1;
        } else {
            partial_records_in += 1;
        }

        let mut data = &mut in_buf[..n];
        let mut owned;

        // Apply conversions
        if opts.conv_ucase {
            owned = data
                .iter()
                .map(|&b| {
                    if b.is_ascii_lowercase() {
                        b.to_ascii_uppercase()
                    } else {
                        b
                    }
                })
                .collect::<Vec<u8>>();
            data = &mut owned;
        } else if opts.conv_lcase {
            owned = data
                .iter()
                .map(|&b| {
                    if b.is_ascii_uppercase() {
                        b.to_ascii_lowercase()
                    } else {
                        b
                    }
                })
                .collect::<Vec<u8>>();
            data = &mut owned;
        }

        match output.write_all(data) {
            Ok(()) => {
                let written = data.len();
                total_bytes += written as u64;
                if written == opts.obs {
                    full_records_out += 1;
                } else {
                    partial_records_out += 1;
                }
            }
            Err(e) => {
                if e.kind() == io::ErrorKind::BrokenPipe {
                    break;
                }
                eprintln!("dd: write error: {e}");
                return 1;
            }
        }
    }

    if !opts.status_none {
        eprintln!("{}+{} records in", full_records_in, partial_records_in);
        eprintln!("{}+{} records out", full_records_out, partial_records_out);
        eprintln!("{} bytes transferred", total_bytes);
    }

    0
}

fn read_full(reader: &mut dyn Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut total = 0;
    while total < buf.len() {
        match reader.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) => return Err(e),
        }
    }
    Ok(total)
}

fn main() {
    process::exit(run());
}
