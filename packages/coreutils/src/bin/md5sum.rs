//! md5sum - compute MD5 message digest

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::process;

/// MD5 per-round shift amounts
const S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/// MD5 round constants: floor(2^32 * abs(sin(i+1))) for i in 0..63
const T: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

struct Md5 {
    state: [u32; 4],
    buffer: Vec<u8>,
    total_len: u64,
}

impl Md5 {
    fn new() -> Self {
        Md5 {
            state: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476],
            buffer: Vec::with_capacity(64),
            total_len: 0,
        }
    }

    fn update(&mut self, data: &[u8]) {
        self.total_len += data.len() as u64;
        self.buffer.extend_from_slice(data);

        while self.buffer.len() >= 64 {
            let block: Vec<u8> = self.buffer.drain(..64).collect();
            self.process_block(&block);
        }
    }

    fn process_block(&mut self, block: &[u8]) {
        // Parse block into sixteen 32-bit little-endian words
        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = (block[i * 4] as u32)
                | ((block[i * 4 + 1] as u32) << 8)
                | ((block[i * 4 + 2] as u32) << 16)
                | ((block[i * 4 + 3] as u32) << 24);
        }

        let mut a = self.state[0];
        let mut b = self.state[1];
        let mut c = self.state[2];
        let mut d = self.state[3];

        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };

            let temp = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                a.wrapping_add(f)
                    .wrapping_add(T[i])
                    .wrapping_add(m[g])
                    .rotate_left(S[i]),
            );
            a = temp;
        }

        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
    }

    fn finalize(mut self) -> [u8; 16] {
        let bit_len = self.total_len * 8;

        // Append padding bit
        self.buffer.push(0x80);

        // Pad to 56 mod 64 bytes
        while self.buffer.len() % 64 != 56 {
            self.buffer.push(0x00);
        }

        // Append original message length in bits as 64-bit little-endian
        self.buffer.extend_from_slice(&bit_len.to_le_bytes());

        // Process remaining blocks
        while self.buffer.len() >= 64 {
            let block: Vec<u8> = self.buffer.drain(..64).collect();
            self.process_block(&block);
        }

        let mut result = [0u8; 16];
        for (i, &val) in self.state.iter().enumerate() {
            result[i * 4] = val as u8;
            result[i * 4 + 1] = (val >> 8) as u8;
            result[i * 4 + 2] = (val >> 16) as u8;
            result[i * 4 + 3] = (val >> 24) as u8;
        }
        result
    }
}

fn md5_reader<R: Read>(mut reader: R) -> io::Result<[u8; 16]> {
    let mut hasher = Md5::new();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(e) => return Err(e),
        }
    }
    Ok(hasher.finalize())
}

fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn check_file(path: &str) -> i32 {
    let reader: Box<dyn BufRead> = if path == "-" {
        Box::new(BufReader::new(io::stdin()))
    } else {
        match File::open(path) {
            Ok(f) => Box::new(BufReader::new(f)),
            Err(e) => {
                eprintln!("md5sum: {}: {}", path, e);
                return 1;
            }
        }
    };

    let mut failures = 0;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("md5sum: {}", e);
                return 1;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(2, "  ").collect();
        if parts.len() != 2 {
            eprintln!("md5sum: {}: improperly formatted checksum line", line);
            failures += 1;
            continue;
        }
        let expected_hash = parts[0];
        let filename = parts[1];

        let computed = if filename == "-" {
            md5_reader(io::stdin())
        } else {
            match File::open(filename) {
                Ok(f) => md5_reader(f),
                Err(e) => {
                    eprintln!("md5sum: {}: {}", filename, e);
                    failures += 1;
                    continue;
                }
            }
        };

        match computed {
            Ok(hash) => {
                let hex = hex_string(&hash);
                if hex == expected_hash {
                    println!("{}: OK", filename);
                } else {
                    println!("{}: FAILED", filename);
                    failures += 1;
                }
            }
            Err(e) => {
                eprintln!("md5sum: {}: {}", filename, e);
                failures += 1;
            }
        }
    }

    if failures > 0 {
        1
    } else {
        0
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--help") {
        println!("Usage: md5sum [-c] [FILE...]");
        println!("Compute or check MD5 message digests.");
        println!("  -c  check MD5 sums from FILE");
        return;
    }

    let check_mode = args.iter().any(|a| a == "-c" || a == "--check");
    let files: Vec<&str> = args[1..]
        .iter()
        .filter(|a| *a != "-c" && *a != "--check")
        .map(|s| s.as_str())
        .collect();

    if check_mode {
        let path = if files.is_empty() { "-" } else { files[0] };
        process::exit(check_file(path));
    }

    if files.is_empty() {
        match md5_reader(io::stdin()) {
            Ok(hash) => println!("{}  -", hex_string(&hash)),
            Err(e) => {
                eprintln!("md5sum: {}", e);
                process::exit(1);
            }
        }
    } else {
        let mut exit_code = 0;
        for file in &files {
            if *file == "-" {
                match md5_reader(io::stdin()) {
                    Ok(hash) => println!("{}  -", hex_string(&hash)),
                    Err(e) => {
                        eprintln!("md5sum: {}", e);
                        exit_code = 1;
                    }
                }
            } else {
                match File::open(file) {
                    Ok(f) => match md5_reader(f) {
                        Ok(hash) => println!("{}  {}", hex_string(&hash), file),
                        Err(e) => {
                            eprintln!("md5sum: {}: {}", file, e);
                            exit_code = 1;
                        }
                    },
                    Err(e) => {
                        eprintln!("md5sum: {}: {}", file, e);
                        exit_code = 1;
                    }
                }
            }
        }
        process::exit(exit_code);
    }
}
