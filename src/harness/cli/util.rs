use serde_json::Value;

use crate::harness::task_view::AgentEventEntry;

/// Compact JSON serialization: one line, no extra whitespace.
pub(crate) fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<invalid-json>".to_string())
}

/// Truncate text to `max_chars` characters, appending "..." if truncated.
pub(crate) fn truncate_text(input: &str, max_chars: usize) -> String {
    let mut chars = input.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

/// Format an agent event entry for human-readable display.
pub(crate) fn format_agent_event(entry: &AgentEventEntry) -> String {
    let source = entry.source.as_deref().unwrap_or("-");
    let event = entry.event.as_deref().unwrap_or("-");
    let name = entry.name.as_deref().unwrap_or("-");
    let objective = entry.objective.as_deref().unwrap_or("-");
    let elapsed = entry
        .elapsed_ms
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string());
    let record = truncate_text(&compact_json(&entry.record), 500);
    format!(
        "run={} event={} node={} op={:?} source={} kind={} name={} elapsed={}ms objective={} record={}",
        entry.run_index,
        entry.event_index,
        entry.node_id,
        entry.operation,
        source,
        event,
        name,
        elapsed,
        objective,
        record
    )
}
