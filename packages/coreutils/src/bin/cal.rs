//! cal - display a calendar
//!
//! Prints a simple monthly calendar. With no arguments, prints the current
//! month. In the WASM sandbox we use a fixed epoch fallback if time is
//! unavailable.

use std::env;
use std::process;

// Days in month (non-leap and leap year)
fn days_in_month(month: u32, year: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn is_leap(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

// Zeller's congruence: returns 0=Sun..6=Sat for the 1st of month/year
fn day_of_week_first(month: u32, year: u32) -> u32 {
    let m = if month < 3 { month + 12 } else { month };
    let y = if month < 3 { year - 1 } else { year };
    let k = (y % 100) as i64;
    let j = (y / 100) as i64;
    let h = (1 + (13 * (m as i64 + 1)) / 5 + k + k / 4 + j / 4 - 2 * j) % 7;
    // h: 0=Sat,1=Sun,...,6=Fri → convert to 0=Sun..6=Sat
    ((h + 6) % 7) as u32
}

const MONTH_NAMES: [&str; 13] = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

fn print_month(month: u32, year: u32) {
    let header = format!("{} {}", MONTH_NAMES[month as usize], year);
    println!("{:^20}", header);
    println!("Su Mo Tu We Th Fr Sa");

    let start = day_of_week_first(month, year);
    let days = days_in_month(month, year);

    let mut col = 0u32;
    // Indent to starting weekday
    for _ in 0..start {
        print!("   ");
        col += 1;
    }

    for day in 1..=days {
        print!("{:2}", day);
        col += 1;
        if col % 7 == 0 {
            println!();
        } else {
            print!(" ");
        }
    }
    if col % 7 != 0 {
        println!();
    }
}

fn current_month_year() -> (u32, u32) {
    // Try to get current time via std::time; fall back to 2025-01 in WASM
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Approximate: days since epoch
    let days = secs / 86400;
    // Compute year and month using a simple algorithm
    let mut year = 1970u32;
    let mut remaining = days;
    loop {
        let year_days = if is_leap(year) { 366 } else { 365 };
        if remaining < year_days {
            break;
        }
        remaining -= year_days;
        year += 1;
    }
    let mut month = 1u32;
    loop {
        let m_days = days_in_month(month, year);
        if remaining < m_days as u64 {
            break;
        }
        remaining -= m_days as u64;
        month += 1;
        if month > 12 {
            break;
        }
    }
    (month, year)
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.iter().any(|a| a == "--help") {
        println!("Usage: cal [[month] year]");
        return;
    }

    let (month, year) = match args.len() {
        1 => current_month_year(),
        2 => {
            // year only — print all 12 months
            let y: u32 = args[1].parse().unwrap_or_else(|_| {
                eprintln!("cal: invalid year: {}", args[1]);
                process::exit(1);
            });
            println!("{:^20}", y);
            for m in 1..=12u32 {
                print_month(m, y);
                println!();
            }
            return;
        }
        3 => {
            let m: u32 = args[1].parse().unwrap_or_else(|_| {
                eprintln!("cal: invalid month: {}", args[1]);
                process::exit(1);
            });
            let y: u32 = args[2].parse().unwrap_or_else(|_| {
                eprintln!("cal: invalid year: {}", args[2]);
                process::exit(1);
            });
            (m, y)
        }
        _ => {
            eprintln!("Usage: cal [[month] year]");
            process::exit(1);
        }
    };

    print_month(month, year);
}
