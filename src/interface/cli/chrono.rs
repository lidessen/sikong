#[allow(dead_code)]
pub fn chrono_now_date() -> String {
    let (y, m, d) = chrono_now_ymd();
    format!("{:04}-{:02}-{:02}", y, m, d)
}

#[allow(dead_code)]
pub fn chrono_now_month() -> String {
    let (y, m, _d) = chrono_now_ymd();
    format!("{:04}-{:02}", y, m)
}

#[allow(dead_code)]
pub fn chrono_now_ymd() -> (i64, i32, i32) {
    // Simple YYYY-MM-DD from system time without pulling in chrono
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Days since epoch
    let days = secs / 86400;
    // Algorithm to compute year/month/day from days since 1970-01-01
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let leap = is_leap(y);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 1;
    for days_in_month in month_days {
        if remaining < days_in_month {
            break;
        }
        remaining -= days_in_month;
        m += 1;
    }
    let d = remaining + 1;
    (y, m, d as i32)
}

#[allow(dead_code)]
pub fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}
