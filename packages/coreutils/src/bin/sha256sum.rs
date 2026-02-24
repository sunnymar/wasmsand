//! sha256sum - compute SHA-256 message digest

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::process;

/// SHA-256 initial hash values (first 32 bits of fractional parts of square roots of first 8 primes)
const H_INIT: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/// SHA-256 round constants (first 32 bits of fractional parts of cube roots of first 64 primes)
const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

struct Sha256 {
    state: [u32; 8],
    buffer: Vec<u8>,
    total_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Sha256 {
            state: H_INIT,
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
        let mut w = [0u32; 64];

        // Prepare message schedule
        for i in 0..16 {
            w[i] = ((block[i * 4] as u32) << 24)
                | ((block[i * 4 + 1] as u32) << 16)
                | ((block[i * 4 + 2] as u32) << 8)
                | (block[i * 4 + 3] as u32);
        }

        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = self.state[0];
        let mut b = self.state[1];
        let mut c = self.state[2];
        let mut d = self.state[3];
        let mut e = self.state[4];
        let mut f = self.state[5];
        let mut g = self.state[6];
        let mut h = self.state[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.total_len * 8;

        // Append padding bit
        self.buffer.push(0x80);

        // Pad to 56 mod 64 bytes
        while self.buffer.len() % 64 != 56 {
            self.buffer.push(0x00);
        }

        // Append original message length in bits as 64-bit big-endian
        self.buffer.extend_from_slice(&bit_len.to_be_bytes());

        // Process remaining blocks
        while self.buffer.len() >= 64 {
            let block: Vec<u8> = self.buffer.drain(..64).collect();
            self.process_block(&block);
        }

        let mut result = [0u8; 32];
        for (i, &val) in self.state.iter().enumerate() {
            result[i * 4] = (val >> 24) as u8;
            result[i * 4 + 1] = (val >> 16) as u8;
            result[i * 4 + 2] = (val >> 8) as u8;
            result[i * 4 + 3] = val as u8;
        }
        result
    }
}

fn sha256_reader<R: Read>(mut reader: R) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
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
                eprintln!("sha256sum: {}: {}", path, e);
                return 1;
            }
        }
    };

    let mut failures = 0;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("sha256sum: {}", e);
                return 1;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Format: hash  filename  (two spaces)
        let parts: Vec<&str> = line.splitn(2, "  ").collect();
        if parts.len() != 2 {
            eprintln!("sha256sum: {}: improperly formatted checksum line", line);
            failures += 1;
            continue;
        }
        let expected_hash = parts[0];
        let filename = parts[1];

        let computed = if filename == "-" {
            sha256_reader(io::stdin())
        } else {
            match File::open(filename) {
                Ok(f) => sha256_reader(f),
                Err(e) => {
                    eprintln!("sha256sum: {}: {}", filename, e);
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
                eprintln!("sha256sum: {}: {}", filename, e);
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
        println!("Usage: sha256sum [-c] [FILE...]");
        println!("Compute or check SHA-256 message digests.");
        println!("  -c  check SHA-256 sums from FILE");
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
        match sha256_reader(io::stdin()) {
            Ok(hash) => println!("{}  -", hex_string(&hash)),
            Err(e) => {
                eprintln!("sha256sum: {}", e);
                process::exit(1);
            }
        }
    } else {
        let mut exit_code = 0;
        for file in &files {
            if *file == "-" {
                match sha256_reader(io::stdin()) {
                    Ok(hash) => println!("{}  -", hex_string(&hash)),
                    Err(e) => {
                        eprintln!("sha256sum: {}", e);
                        exit_code = 1;
                    }
                }
            } else {
                match File::open(file) {
                    Ok(f) => match sha256_reader(f) {
                        Ok(hash) => println!("{}  {}", hex_string(&hash), file),
                        Err(e) => {
                            eprintln!("sha256sum: {}: {}", file, e);
                            exit_code = 1;
                        }
                    },
                    Err(e) => {
                        eprintln!("sha256sum: {}: {}", file, e);
                        exit_code = 1;
                    }
                }
            }
        }
        process::exit(exit_code);
    }
}
