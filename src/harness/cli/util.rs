use serde_json::Value;

use super::task::{AgentEventEntry, AgentEventFilter};

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

/// Filter predicate: returns true if the entry matches all non-None filter fields.
pub(crate) fn agent_event_matches(entry: &AgentEventEntry, filter: &AgentEventFilter) -> bool {
    if filter
        .operation
        .is_some_and(|operation| entry.operation != operation)
    {
        return false;
    }
    if !optional_eq(filter.event.as_deref(), entry.event.as_deref()) {
        return false;
    }
    if !optional_eq(filter.tool.as_deref(), entry.name.as_deref()) {
        return false;
    }
    if !optional_eq(filter.source.as_deref(), entry.source.as_deref()) {
        return false;
    }
    if let Some(query) = &filter.query {
        let haystack = compact_json(&entry.record).to_lowercase();
        if !haystack.contains(&query.to_lowercase()) {
            return false;
        }
    }
    true
}

/// Case-insensitive optional equality: if `expected` is None, always matches.
pub(crate) fn optional_eq(expected: Option<&str>, actual: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    actual.is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
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

/// Extract an optional string value from a JSON object by key.
pub(crate) fn json_string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/// Extract an optional u64 value from a JSON object by key.
pub(crate) fn json_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key)?.as_u64()
}
