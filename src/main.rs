use siko::interface::cli;

fn main() {
    std::process::exit(cli::run(std::env::args().skip(1)));
}
