use crate::common::metrics::{MetricsCollector, MetricsFormatter};
use super::print_json_data;

/// Collect and display current metrics snapshot.
pub fn run_metrics_command(json_output: bool) {
    // TODO: Integrate with a global/live MetricsCollector instance once one is
    //       established by the engine or session lifecycle. For now, this
    //       creates a fresh collector and populates it with basic process-level
    //       metrics as a demonstration of the pipeline.
    let mut collector = MetricsCollector::new();

    // Record some basic process-level metrics
    let uptime = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    collector.increment_counter("uptime_seconds", uptime.as_secs());
    collector.record_timing("uptime", uptime);
    collector.record_cost("version_cost", 0.1);

    let snapshot = collector.snapshot();

    if json_output {
        print_json_data(snapshot.to_json_value());
    } else {
        let formatter = MetricsFormatter;
        let output = formatter.format(&snapshot);
        println!("{output}");
    }
}
