use std::{
    env,
    io::{self, Read},
    process,
};

fn bsd_sum(data: &[u8]) -> (u16, usize) {
    let mut checksum: u16 = 0;
    for &byte in data {
        checksum = (checksum >> 1) + ((checksum & 1) << 15);
        checksum = checksum.wrapping_add(byte as u16);
    }
    let blocks = data.len().div_ceil(1024);
    (checksum, blocks)
}

fn sysv_sum(data: &[u8]) -> (u16, usize) {
    let mut s: u32 = 0;
    for &byte in data {
        s = s.wrapping_add(byte as u32);
    }
    let mut r = (s & 0xffff) + (s >> 16);
    r = (r & 0xffff) + (r >> 16);
    let blocks = data.len().div_ceil(512);
    (r as u16, blocks)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut sysv = false;
    let mut files: Vec<String> = Vec::new();
    for arg in args.iter().skip(1) {
        match arg.as_str() {
            "-s" | "--sysv" => sysv = true,
            "-r" => sysv = false, // BSD (default)
            _ => files.push(arg.clone()),
        }
    }

    if files.is_empty() {
        files.push("-".to_string());
    }

    for file in &files {
        let mut data = Vec::new();
        if file == "-" {
            io::stdin().read_to_end(&mut data).unwrap_or_else(|e| {
                eprintln!("sum: stdin: {}", e);
                process::exit(1);
            });
        } else {
            std::fs::File::open(file)
                .and_then(|mut f| f.read_to_end(&mut data))
                .unwrap_or_else(|e| {
                    eprintln!("sum: {}: {}", file, e);
                    process::exit(1);
                });
        }
        let (cksum, blocks) = if sysv {
            sysv_sum(&data)
        } else {
            bsd_sum(&data)
        };
        if files.len() > 1 || file != "-" {
            println!("{:05} {:>5} {}", cksum, blocks, file);
        } else {
            println!("{:05} {:>5}", cksum, blocks);
        }
    }
}
