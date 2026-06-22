use std::collections::HashMap;
use std::time::Duration;

/// A self-contained metrics collection module.
///
/// Collects counters, timings, and cost measurements by name.
/// Provides an immutable snapshot via `snapshot()`.
pub struct MetricsCollector {
    counters: HashMap<String, u64>,
    timings: HashMap<String, Vec<Duration>>,
    costs: HashMap<String, Vec<f64>>,
}

impl MetricsCollector {
    /// Create a new empty collector.
    pub fn new() -> Self {
        Self {
            counters: HashMap::new(),
            timings: HashMap::new(),
            costs: HashMap::new(),
        }
    }

    /// Push a counter value by name. The value is accumulated.
    pub fn increment_counter(&mut self, name: &str, amount: u64) {
        *self.counters.entry(name.to_string()).or_insert(0) += amount;
    }

    /// Record a timing measurement by name.
    pub fn record_timing(&mut self, name: &str, duration: Duration) {
        self.timings
            .entry(name.to_string())
            .or_default()
            .push(duration);
    }

    /// Record a cost measurement by name.
    pub fn record_cost(&mut self, name: &str, amount: f64) {
        self.costs.entry(name.to_string()).or_default().push(amount);
    }

    /// Record an agent run's usage data by operation type.
    ///
    /// Tracks per-operation statistics (counts, sums, averages, ratios).
    /// No subjective scoring, rating, or quality analysis is performed.
    ///
    /// # Parameters
    ///
    /// *  - The operation name, e.g. "Specify", "Execute", "Plan", "Verify", "Combine", "Commit".
    /// *  - Number of input tokens consumed.
    /// *  - Number of output tokens generated.
    /// *  - Number of cache read tokens.
    /// *  - Duration of the run in milliseconds.
    /// *  - Whether the run completed successfully.
    pub fn record_agent_run(
        &mut self,
        operation: &str,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        duration_ms: u128,
        passed: bool,
    ) {
        let op_key = operation.to_lowercase();

        // Per-operation counters
        self.increment_counter(&format!("{op_key}.count"), 1);
        self.increment_counter(&format!("{op_key}.input_tokens"), input_tokens);
        self.increment_counter(&format!("{op_key}.output_tokens"), output_tokens);
        self.increment_counter(&format!("{op_key}.cache_read_tokens"), cache_read_tokens);
        if passed {
            self.increment_counter(&format!("{op_key}.passed"), 1);
        } else {
            self.increment_counter(&format!("{op_key}.failed"), 1);
        }

        // Per-operation timings (ms)
        self.record_timing(
            &format!("{op_key}.duration_ms"),
            Duration::from_millis(duration_ms as u64),
        );

        // Aggregate totals
        self.increment_counter("total.runs", 1);
        self.increment_counter("total.input_tokens", input_tokens);
        self.increment_counter("total.output_tokens", output_tokens);
        self.increment_counter("total.cache_read_tokens", cache_read_tokens);
        if passed {
            self.increment_counter("total.passed", 1);
        } else {
            self.increment_counter("total.failed", 1);
        }
        self.record_timing(
            "total.duration_ms",
            Duration::from_millis(duration_ms as u64),
        );
    }

    /// Retrieve all collected data as an immutable snapshot.
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            counters: self.counters.clone(),
            timings: self.timings.clone(),
            costs: self.costs.clone(),
        }
    }
}

impl Default for MetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}

/// Immutable snapshot of collected metrics at a point in time.
pub struct MetricsSnapshot {
    counters: HashMap<String, u64>,
    timings: HashMap<String, Vec<Duration>>,
    costs: HashMap<String, Vec<f64>>,
}

impl MetricsSnapshot {
    /// Access the collected counters.
    pub fn counters(&self) -> &HashMap<String, u64> {
        &self.counters
    }

    /// Access the collected timings.
    pub fn timings(&self) -> &HashMap<String, Vec<Duration>> {
        &self.timings
    }

    /// Access the collected costs.
    pub fn costs(&self) -> &HashMap<String, Vec<f64>> {
        &self.costs
    }

    /// Render the snapshot as a serde_json::Value for embedding in JSON output.
    ///
    /// The structure matches JSON output:
    /// - `counters`: flat key-value map
    /// - `timings`: keys mapped to arrays of millisecond values
    /// - `costs`: keys mapped to arrays of cost values
    pub fn to_json_value(&self) -> serde_json::Value {
        let timings_ms: HashMap<String, Vec<f64>> = self
            .timings
            .iter()
            .map(|(key, durations)| {
                (
                    key.clone(),
                    durations.iter().map(|d| d.as_secs_f64() * 1000.0).collect(),
                )
            })
            .collect();

        serde_json::json!({
            "counters": self.counters,
            "timings": timings_ms,
            "costs": self.costs,
        })
    }
}

// ---------------------------------------------------------------------------
// JSON formatting
// ---------------------------------------------------------------------------

/// Formats a [`MetricsSnapshot`] as a human-readable JSON string.
///
/// Timings are converted to milliseconds (as `f64`) for clean JSON output.
pub struct MetricsFormatter;

impl MetricsFormatter {
    /// Render the snapshot to a pretty-printed JSON string.
    ///
    /// # Example output
    ///
    /// ```json
    /// {
    ///   "counters": { "requests": 42 },
    ///   "timings":  { "api_latency": [150.0] },
    ///   "costs":    { "compute": [3.5] }
    /// }
    /// ```
    pub fn format(&self, snapshot: &MetricsSnapshot) -> String {
        format_metrics(snapshot)
    }
}

/// Produces a JSON string from a [`MetricsSnapshot`].
///
/// Timings are rendered as millisecond floating-point values.
/// The output is human-readable (pretty-printed) JSON.
pub fn format_metrics(snapshot: &MetricsSnapshot) -> String {
    serde_json::to_string_pretty(&snapshot.to_json_value()).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_collector_is_empty() {
        let collector = MetricsCollector::new();
        let snapshot = collector.snapshot();
        assert!(snapshot.counters().is_empty());
        assert!(snapshot.timings().is_empty());
        assert!(snapshot.costs().is_empty());
    }

    #[test]
    fn test_increment_counter_accumulates() {
        let mut collector = MetricsCollector::new();
        collector.increment_counter("requests", 1);
        collector.increment_counter("requests", 2);
        collector.increment_counter("errors", 1);

        let snapshot = collector.snapshot();
        assert_eq!(snapshot.counters().get("requests"), Some(&3));
        assert_eq!(snapshot.counters().get("errors"), Some(&1));
        assert_eq!(snapshot.counters().get("nonexistent"), None);
    }

    #[test]
    fn test_record_timing() {
        let mut collector = MetricsCollector::new();
        collector.record_timing("api_call", Duration::from_millis(5));

        let snapshot = collector.snapshot();
        let timings = snapshot.timings().get("api_call").unwrap();
        assert_eq!(timings.len(), 1);
        assert_eq!(timings[0], Duration::from_millis(5));
    }

    #[test]
    fn test_record_cost() {
        let mut collector = MetricsCollector::new();
        collector.record_cost("compute", 0.5);
        collector.record_cost("compute", 1.5);
        collector.record_cost("storage", 2.0);

        let snapshot = collector.snapshot();
        assert_eq!(snapshot.costs().get("compute"), Some(&vec![0.5, 1.5]));
        assert_eq!(snapshot.costs().get("storage"), Some(&vec![2.0]));
    }

    #[test]
    fn test_snapshot_is_independent_of_subsequent_mutations() {
        let mut collector = MetricsCollector::new();
        collector.increment_counter("requests", 5);

        let snapshot = collector.snapshot();
        assert_eq!(snapshot.counters().get("requests"), Some(&5));

        // Mutate after snapshot — original snapshot must be unchanged
        collector.increment_counter("requests", 3);
        assert_eq!(snapshot.counters().get("requests"), Some(&5));

        let snapshot2 = collector.snapshot();
        assert_eq!(snapshot2.counters().get("requests"), Some(&8));
    }

    #[test]
    fn test_full_api_workflow() {
        let mut collector = MetricsCollector::new();

        // Push counters
        collector.increment_counter("api_calls", 10);
        collector.increment_counter("errors", 2);

        // Record a timing measurement
        collector.record_timing("latency", Duration::from_millis(3));

        // Record cost
        collector.record_cost("compute_hours", 3.5);

        // Retrieve snapshot
        let snapshot = collector.snapshot();

        // Verify snapshot contains expected data
        assert_eq!(snapshot.counters().get("api_calls"), Some(&10));
        assert_eq!(snapshot.counters().get("errors"), Some(&2));
        assert!(snapshot.timings().contains_key("latency"));
        assert_eq!(snapshot.costs().get("compute_hours"), Some(&vec![3.5]));
    }

    #[test]
    fn test_default_impl() {
        let collector = MetricsCollector::default();
        let snapshot = collector.snapshot();
        assert!(snapshot.counters().is_empty());
    }

    #[test]
    fn test_multiple_timings_per_name() {
        let mut collector = MetricsCollector::new();
        collector.record_timing("query", Duration::from_millis(10));
        collector.record_timing("query", Duration::from_millis(20));
        collector.record_timing("query", Duration::from_millis(30));

        let snapshot = collector.snapshot();
        let timings = snapshot.timings().get("query").unwrap();
        assert_eq!(timings.len(), 3);
        assert_eq!(timings[0], Duration::from_millis(10));
        assert_eq!(timings[1], Duration::from_millis(20));
        assert_eq!(timings[2], Duration::from_millis(30));
    }

    // -----------------------------------------------------------------------
    // MetricsFormatter / format_metrics tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_metrics_formatter_struct() {
        let formatter = MetricsFormatter;
        let mut collector = MetricsCollector::new();
        collector.increment_counter("x", 1);
        let snapshot = collector.snapshot();
        let json = formatter.format(&snapshot);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["counters"]["x"], 1);
    }

    #[test]
    fn test_format_metrics_returns_valid_json() {
        let mut collector = MetricsCollector::new();
        collector.increment_counter("requests", 42);
        collector.record_cost("compute", 1.5);
        let snapshot = collector.snapshot();

        let json = format_metrics(&snapshot);
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("format_metrics must produce valid JSON");

        // Top-level keys
        assert!(parsed.is_object(), "output must be a JSON object");
        let obj = parsed.as_object().unwrap();
        assert!(obj.contains_key("counters"), "must have 'counters' key");
        assert!(obj.contains_key("timings"), "must have 'timings' key");
        assert!(obj.contains_key("costs"), "must have 'costs' key");
    }

    #[test]
    fn test_format_metrics_expected_values() {
        let mut collector = MetricsCollector::new();
        collector.increment_counter("requests", 5);
        collector.increment_counter("errors", 1);
        collector.record_cost("compute", 3.5);
        collector.record_timing("api_latency", Duration::from_millis(150));

        let snapshot = collector.snapshot();
        let json = format_metrics(&snapshot);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        // Counters
        let counters = &parsed["counters"];
        assert_eq!(counters["requests"], 5);
        assert_eq!(counters["errors"], 1);

        // Costs
        let costs = &parsed["costs"];
        assert_eq!(costs["compute"][0], 3.5);

        // Timings – should be in milliseconds as f64
        let timings = &parsed["timings"];
        let latencies = timings["api_latency"].as_array().unwrap();
        assert_eq!(latencies.len(), 1);
        let ms = latencies[0].as_f64().unwrap();
        // 150 ms exactly when converted via as_secs_f64() * 1000.0
        assert!((ms - 150.0).abs() < 0.001, "expected ~150 ms, got {ms}");
    }

    #[test]
    fn test_format_metrics_empty_snapshot() {
        let collector = MetricsCollector::new();
        let snapshot = collector.snapshot();
        let json = format_metrics(&snapshot);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert!(parsed["counters"].as_object().unwrap().is_empty());
        assert!(parsed["timings"].as_object().unwrap().is_empty());
        assert!(parsed["costs"].as_object().unwrap().is_empty());
    }

    #[test]
    fn test_format_metrics_multiple_timings() {
        let mut collector = MetricsCollector::new();
        collector.record_timing("query", Duration::from_millis(10));
        collector.record_timing("query", Duration::from_millis(20));
        collector.record_timing("query", Duration::from_millis(30));

        let snapshot = collector.snapshot();
        let json = format_metrics(&snapshot);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        let timings = parsed["timings"]["query"].as_array().unwrap();
        assert_eq!(timings.len(), 3);
        let ms: Vec<f64> = timings.iter().map(|v| v.as_f64().unwrap()).collect();
        assert!((ms[0] - 10.0).abs() < 0.001);
        assert!((ms[1] - 20.0).abs() < 0.001);
        assert!((ms[2] - 30.0).abs() < 0.001);
    }

    #[test]
    fn test_format_metrics_is_pretty_printed() {
        let mut collector = MetricsCollector::new();
        collector.increment_counter("x", 1);
        let snapshot = collector.snapshot();
        let json = format_metrics(&snapshot);

        // Pretty-printed JSON should contain newlines and indentation
        assert!(
            json.contains('\n'),
            "expected pretty-printed JSON with newlines"
        );
        assert!(
            json.contains("  "),
            "expected pretty-printed JSON with indentation"
        );
    }
}
