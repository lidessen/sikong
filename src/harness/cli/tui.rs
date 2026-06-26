use std::io::{self, Stdout};
use std::time::{Duration, Instant};

use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
};
use serde_json::json;

use crate::{
    AssistantTask, AssistantTaskEvent, AssistantTaskStatus, DebugConfig, FileTaskStore, TaskStore,
    harness::{
        daemon,
        task_view::{
            TaskEventCursor, TaskTimelineRecord, inspect_task_view, sort_tasks_newest_first,
            task_list_id,
        },
    },
};

use super::{task, util};

const REFRESH_INTERVAL: Duration = Duration::from_secs(1);

pub fn run_tui() -> Result<(), Box<dyn std::error::Error>> {
    let debug = DebugConfig::from_env();
    daemon::ensure_daemon_running(&debug)?;

    let mut terminal = TerminalSession::enter()?;
    let mut app = TuiApp::new(debug);
    app.refresh();

    let result = app.run(&mut terminal);
    drop(terminal);
    result
}

struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    active: bool,
}

impl TerminalSession {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
        let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;
        terminal.clear()?;
        Ok(Self {
            terminal,
            active: true,
        })
    }

    fn draw<F>(&mut self, render: F) -> io::Result<()>
    where
        F: FnOnce(&mut ratatui::Frame<'_>),
    {
        self.terminal.draw(render)?;
        Ok(())
    }

    fn suspend(&mut self) -> io::Result<()> {
        if self.active {
            disable_raw_mode()?;
            execute!(
                self.terminal.backend_mut(),
                LeaveAlternateScreen,
                DisableMouseCapture
            )?;
            self.terminal.show_cursor()?;
            self.active = false;
        }
        Ok(())
    }

    fn resume(&mut self) -> io::Result<()> {
        if !self.active {
            enable_raw_mode()?;
            execute!(
                self.terminal.backend_mut(),
                EnterAlternateScreen,
                EnableMouseCapture
            )?;
            self.terminal.clear()?;
            self.active = true;
        }
        Ok(())
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        if self.active {
            let _ = disable_raw_mode();
            let _ = execute!(
                self.terminal.backend_mut(),
                LeaveAlternateScreen,
                DisableMouseCapture
            );
            let _ = self.terminal.show_cursor();
            self.active = false;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetailMode {
    Timeline,
    Artifact,
    Request,
}

struct TuiApp {
    debug: DebugConfig,
    tasks: Vec<AssistantTask>,
    selected: usize,
    detail_scroll: u16,
    mode: DetailMode,
    status: String,
    last_refresh: Instant,
}

impl TuiApp {
    fn new(debug: DebugConfig) -> Self {
        Self {
            debug,
            tasks: Vec::new(),
            selected: 0,
            detail_scroll: 0,
            mode: DetailMode::Timeline,
            status: "ready".to_string(),
            last_refresh: Instant::now(),
        }
    }

    fn run(&mut self, terminal: &mut TerminalSession) -> Result<(), Box<dyn std::error::Error>> {
        loop {
            if self.last_refresh.elapsed() >= REFRESH_INTERVAL {
                self.refresh();
            }

            terminal.draw(|frame| self.render(frame))?;

            if !event::poll(Duration::from_millis(200))? {
                continue;
            }

            let Event::Key(key) = event::read()? else {
                continue;
            };
            if key.kind != KeyEventKind::Press {
                continue;
            }

            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                KeyCode::Char('r') => self.refresh(),
                KeyCode::Char('n') => self.prompt_new_task(terminal)?,
                KeyCode::Char('t') => self.set_mode(DetailMode::Timeline),
                KeyCode::Char('a') => self.set_mode(DetailMode::Artifact),
                KeyCode::Char('p') => self.set_mode(DetailMode::Request),
                KeyCode::Down | KeyCode::Char('j') => self.select_next(),
                KeyCode::Up | KeyCode::Char('k') => self.select_previous(),
                KeyCode::PageDown => self.scroll_detail(8),
                KeyCode::PageUp => self.scroll_detail(-8),
                KeyCode::Home => self.select_first(),
                KeyCode::End => self.select_last(),
                _ => {}
            }
        }
    }

    fn refresh(&mut self) {
        self.last_refresh = Instant::now();
        match FileTaskStore::open(task::assistant_store_path(&self.debug)) {
            Ok(store) => {
                let selected_id = self.selected_task().map(|task| task.id.clone());
                let mut tasks = store.list_tasks();
                sort_tasks_newest_first(&mut tasks);
                if let Some(selected_id) = selected_id
                    && let Some(index) = tasks.iter().position(|task| task.id == selected_id)
                {
                    self.selected = index;
                }
                self.tasks = tasks;
                if self.tasks.is_empty() {
                    self.selected = 0;
                } else {
                    self.selected = self.selected.min(self.tasks.len() - 1);
                }
            }
            Err(error) => {
                self.status = format!("failed to read task store: {error}");
            }
        }
    }

    fn prompt_new_task(
        &mut self,
        terminal: &mut TerminalSession,
    ) -> Result<(), Box<dyn std::error::Error>> {
        terminal.suspend()?;
        let prompt = dialoguer::Input::<String>::new()
            .with_prompt("Task")
            .allow_empty(true)
            .interact_text();
        terminal.resume()?;

        let prompt = prompt?;
        let prompt = prompt.trim();
        if prompt.is_empty() {
            self.status = "new task cancelled".to_string();
            return Ok(());
        }

        let request = json!({
            "kind": "send",
            "id": "tui-send",
            "message": prompt,
            "wait_ms": 0,
            "workspace": "current-file-system",
            "allow_write": true,
            "write_scope": ["**/*"],
        });
        match daemon::send_json_to_daemon(&self.debug, request) {
            Ok(response) => {
                let task_id = response
                    .get("task_id")
                    .and_then(serde_json::Value::as_str)
                    .map(task_list_id)
                    .unwrap_or_else(|| "no task".to_string());
                let status = response
                    .get("status")
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "unknown".to_string());
                self.status = format!("submitted {task_id} status={status}");
                self.refresh();
            }
            Err(error) => {
                self.status = format!("send failed: {error}");
            }
        }
        Ok(())
    }

    fn set_mode(&mut self, mode: DetailMode) {
        self.mode = mode;
        self.detail_scroll = 0;
    }

    fn select_next(&mut self) {
        if self.tasks.is_empty() {
            return;
        }
        self.selected = (self.selected + 1).min(self.tasks.len() - 1);
        self.detail_scroll = 0;
    }

    fn select_previous(&mut self) {
        self.selected = self.selected.saturating_sub(1);
        self.detail_scroll = 0;
    }

    fn select_first(&mut self) {
        self.selected = 0;
        self.detail_scroll = 0;
    }

    fn select_last(&mut self) {
        if !self.tasks.is_empty() {
            self.selected = self.tasks.len() - 1;
            self.detail_scroll = 0;
        }
    }

    fn scroll_detail(&mut self, delta: i16) {
        if delta.is_negative() {
            self.detail_scroll = self.detail_scroll.saturating_sub(delta.unsigned_abs());
        } else {
            self.detail_scroll = self.detail_scroll.saturating_add(delta as u16);
        }
    }

    fn selected_task(&self) -> Option<&AssistantTask> {
        self.tasks.get(self.selected)
    }

    fn render(&mut self, frame: &mut ratatui::Frame<'_>) {
        let root = frame.area();
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(8),
                Constraint::Length(3),
                Constraint::Length(1),
            ])
            .split(root);
        if rows[0].width < 96 {
            let panels = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(8), Constraint::Min(6)])
                .split(rows[0]);
            self.render_tasks(frame, panels[0]);
            self.render_detail(frame, panels[1]);
        } else {
            let columns = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(34), Constraint::Percentage(66)])
                .split(rows[0]);
            self.render_tasks(frame, columns[0]);
            self.render_detail(frame, columns[1]);
        }
        self.render_status(frame, rows[1]);
        self.render_keys(frame, rows[2]);
    }

    fn render_tasks(&mut self, frame: &mut ratatui::Frame<'_>, area: Rect) {
        let title_width = area.width.saturating_sub(24) as usize;
        let items = self
            .tasks
            .iter()
            .map(|task| {
                let status = status_label(&task.status);
                let id = short_task_id(&task.id);
                let title = first_line(&task.request, title_width.max(12));
                ListItem::new(Line::from(vec![
                    Span::styled(status, status_style(&task.status)),
                    Span::raw(" "),
                    Span::styled(id, Style::default().fg(Color::DarkGray)),
                    Span::raw(" "),
                    Span::raw(title),
                ]))
            })
            .collect::<Vec<_>>();

        let list = List::new(items)
            .block(Block::default().borders(Borders::ALL).title("Tasks"))
            .highlight_style(Style::default().add_modifier(Modifier::REVERSED))
            .highlight_symbol(">");
        let mut state = ListState::default();
        if !self.tasks.is_empty() {
            state.select(Some(self.selected));
        }
        frame.render_stateful_widget(list, area, &mut state);
    }

    fn render_detail(&self, frame: &mut ratatui::Frame<'_>, area: Rect) {
        let title = match self.mode {
            DetailMode::Timeline => "Timeline",
            DetailMode::Artifact => "Artifact",
            DetailMode::Request => "Request",
        };
        let inner_width = area.width.saturating_sub(2).max(20) as usize;
        let lines = self.detail_lines(inner_width);
        let paragraph = Paragraph::new(lines)
            .block(Block::default().borders(Borders::ALL).title(title))
            .wrap(Wrap { trim: true })
            .scroll((self.detail_scroll, 0));
        frame.render_widget(paragraph, area);
    }

    fn render_status(&self, frame: &mut ratatui::Frame<'_>, area: Rect) {
        let daemon = if daemon::daemon_is_running(&self.debug) {
            Span::styled("daemon:up", Style::default().fg(Color::Green))
        } else {
            Span::styled("daemon:down", Style::default().fg(Color::Red))
        };
        let status = Paragraph::new(Line::from(vec![
            daemon,
            Span::raw("  "),
            Span::raw(self.status.as_str()),
        ]))
        .block(Block::default().borders(Borders::ALL).title("Status"));
        frame.render_widget(status, area);
    }

    fn render_keys(&self, frame: &mut ratatui::Frame<'_>, area: Rect) {
        let text = if area.width < 72 {
            "q quit  n new  r refresh  j/k select  t/a/p view"
        } else {
            "q quit  n new  r refresh  ↑/↓ select  PgUp/PgDn scroll  t timeline  a artifact  p prompt"
        };
        let keys = Paragraph::new(text);
        frame.render_widget(keys, area);
    }

    fn detail_lines(&self, width: usize) -> Vec<Line<'static>> {
        let Some(task) = self.selected_task() else {
            return vec![Line::from("No tasks yet. Press n to send one.")];
        };

        let id = if width < 44 {
            short_task_id(&task.id)
        } else {
            task.id.clone()
        };
        let mut lines = vec![
            Line::from(vec![
                Span::styled("id: ", Style::default().fg(Color::DarkGray)),
                Span::raw(id),
            ]),
            Line::from(vec![
                Span::styled("status: ", Style::default().fg(Color::DarkGray)),
                Span::styled(status_label(&task.status), status_style(&task.status)),
            ]),
            Line::from(""),
        ];

        match self.mode {
            DetailMode::Timeline => {
                let timeline = format_task_timeline_lines(task, width);
                if timeline.is_empty() {
                    lines.push(Line::from("No events yet."));
                } else {
                    lines.extend(timeline.into_iter().map(Line::from));
                }
            }
            DetailMode::Artifact => {
                if let Some(report) = &task.last_report
                    && let Some(text) = report.artifact_text.as_deref()
                {
                    lines.extend(text.lines().map(|line| Line::from(line.to_string())));
                } else {
                    lines.push(Line::from("No artifact yet."));
                }
            }
            DetailMode::Request => {
                lines.extend(
                    task.request
                        .lines()
                        .map(|line| Line::from(line.to_string())),
                );
            }
        }

        lines
    }
}

fn first_line(input: &str, max_chars: usize) -> String {
    util::truncate_text(input.lines().next().unwrap_or_default(), max_chars)
}

fn short_task_id(task_id: &str) -> String {
    task_id.chars().take(8).collect()
}

fn task_timeline_base_ms(task: &AssistantTask) -> u64 {
    if task.created_at_ms != 0 {
        return task.created_at_ms;
    }
    task.events
        .first()
        .map(|event| event.timestamp_ms)
        .unwrap_or_default()
}

fn format_task_timeline_lines(task: &AssistantTask, width: usize) -> Vec<String> {
    let base_timestamp_ms = task_timeline_base_ms(task);
    let view = inspect_task_view(task, TaskEventCursor::default());
    let mut lines = Vec::new();
    let mut pending_agent_events: Option<AgentTaskEventGroup> = None;

    for record in view.events {
        match record {
            TaskTimelineRecord::TaskEvent { event, .. }
                if agent_task_event_groupable(&event)
                    && !agent_task_event_needs_attention(&event) =>
            {
                let key = AgentTaskEventGroupKey::from_event(&event);
                if pending_agent_events
                    .as_ref()
                    .is_none_or(|group| group.key != key)
                {
                    flush_agent_task_event_group(
                        &mut lines,
                        &mut pending_agent_events,
                        base_timestamp_ms,
                        width,
                    );
                }
                pending_agent_events
                    .get_or_insert_with(|| AgentTaskEventGroup::new(key, event.timestamp_ms))
                    .push(&event);
            }
            TaskTimelineRecord::TaskEvent { event, .. } => {
                flush_agent_task_event_group(
                    &mut lines,
                    &mut pending_agent_events,
                    base_timestamp_ms,
                    width,
                );
                lines.push(format_task_event_line(&event, base_timestamp_ms, width));
            }
            TaskTimelineRecord::AgentEvent { event, ordinal, .. } => {
                flush_agent_task_event_group(
                    &mut lines,
                    &mut pending_agent_events,
                    base_timestamp_ms,
                    width,
                );
                lines.push(format_agent_event_line(&event, ordinal, width));
            }
        }
    }
    flush_agent_task_event_group(
        &mut lines,
        &mut pending_agent_events,
        base_timestamp_ms,
        width,
    );

    lines
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentTaskEventGroupKey {
    kind: String,
    node_id: Option<u64>,
    operation: Option<crate::NodeOperation>,
    branch_root_node_id: Option<u64>,
    local_node_id: Option<u64>,
}

impl AgentTaskEventGroupKey {
    fn from_event(event: &AssistantTaskEvent) -> Self {
        Self {
            kind: event.kind.clone(),
            node_id: event.node_id,
            operation: event.operation,
            branch_root_node_id: json_u64(&event.payload, "branch_root_node_id"),
            local_node_id: json_u64(&event.payload, "local_node_id"),
        }
    }
}

#[derive(Debug, Clone)]
struct AgentTaskEventGroup {
    key: AgentTaskEventGroupKey,
    first_timestamp_ms: u64,
    last_timestamp_ms: u64,
    count: usize,
    tool_starts: usize,
    tool_ends: usize,
    usage: usize,
    steps: usize,
    text: usize,
    other_events: Vec<String>,
    tools: Vec<String>,
}

impl AgentTaskEventGroup {
    fn new(key: AgentTaskEventGroupKey, timestamp_ms: u64) -> Self {
        Self {
            key,
            first_timestamp_ms: timestamp_ms,
            last_timestamp_ms: timestamp_ms,
            count: 0,
            tool_starts: 0,
            tool_ends: 0,
            usage: 0,
            steps: 0,
            text: 0,
            other_events: Vec::new(),
            tools: Vec::new(),
        }
    }

    fn push(&mut self, event: &AssistantTaskEvent) {
        self.count += 1;
        self.last_timestamp_ms = event.timestamp_ms;
        let event_name = agent_task_event_name(event).unwrap_or_else(|| "unknown".to_string());
        match event_name.as_str() {
            "tool_call_start" => self.tool_starts += 1,
            "tool_call_end" => self.tool_ends += 1,
            "usage" => self.usage += 1,
            "step" => self.steps += 1,
            "text" | "thinking" => self.text += 1,
            _ => push_unique_limited(&mut self.other_events, event_name, 4),
        }
        if let Some(tool) = agent_task_event_tool_name(event) {
            push_unique_limited(&mut self.tools, tool, 4);
        }
    }

    fn format_line(&self, base_ms: u64, width: usize) -> String {
        let elapsed = if self.first_timestamp_ms == self.last_timestamp_ms {
            elapsed_label(self.first_timestamp_ms.saturating_sub(base_ms))
        } else {
            format!(
                "{}..{}",
                elapsed_label(self.first_timestamp_ms.saturating_sub(base_ms)),
                elapsed_label(self.last_timestamp_ms.saturating_sub(base_ms))
            )
        };
        let label = if self.key.kind == "agent.branch.run.event" {
            "branch events"
        } else {
            "agent events"
        };
        let mut parts = vec![format!("{} events", self.count)];
        if self.tool_starts > 0 {
            parts.push(format!("tool_start={}", self.tool_starts));
        }
        if self.tool_ends > 0 {
            parts.push(format!("tool_done={}", self.tool_ends));
        }
        if self.steps > 0 {
            parts.push(format!("step={}", self.steps));
        }
        if self.usage > 0 {
            parts.push(format!("usage={}", self.usage));
        }
        if self.text > 0 {
            parts.push(format!("text={}", self.text));
        }
        if !self.tools.is_empty() {
            parts.push(format!("tools={}", self.tools.join(",")));
        }
        if !self.other_events.is_empty() {
            parts.push(format!("other={}", self.other_events.join(",")));
        }
        if let Some(operation) = self.key.operation {
            parts.push(format!("op={operation:?}"));
        }
        if let Some(node_id) = self.key.node_id {
            parts.push(format!("node={node_id}"));
        }
        if let Some(branch) = self.key.branch_root_node_id {
            parts.push(format!("branch={branch}"));
        }
        if let Some(local) = self.key.local_node_id {
            parts.push(format!("local={local}"));
        }

        let line = format!("{elapsed:<8} {label:<12} {}", parts.join(" "));
        util::truncate_text(&line, width.saturating_sub(1).max(20))
    }
}

fn flush_agent_task_event_group(
    lines: &mut Vec<String>,
    pending: &mut Option<AgentTaskEventGroup>,
    base_ms: u64,
    width: usize,
) {
    let Some(group) = pending.take() else {
        return;
    };
    lines.push(group.format_line(base_ms, width));
}

fn agent_task_event_groupable(event: &AssistantTaskEvent) -> bool {
    matches!(
        event.kind.as_str(),
        "agent.run.event" | "agent.branch.run.event"
    )
}

fn agent_task_event_needs_attention(event: &AssistantTaskEvent) -> bool {
    matches!(
        agent_task_event_name(event).as_deref(),
        Some("error") | Some("tool_call_error")
    )
}

fn agent_task_event_name(event: &AssistantTaskEvent) -> Option<String> {
    event
        .payload
        .get("event")
        .and_then(|event| event.get("event"))
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

fn agent_task_event_tool_name(event: &AssistantTaskEvent) -> Option<String> {
    event
        .payload
        .get("event")
        .and_then(|event| event.get("name"))
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

fn push_unique_limited(values: &mut Vec<String>, value: String, limit: usize) {
    if values.iter().any(|existing| existing == &value) {
        return;
    }
    if values.len() < limit {
        values.push(value);
    }
}

fn format_task_event_line(event: &AssistantTaskEvent, base_ms: u64, width: usize) -> String {
    let elapsed = elapsed_label(event.timestamp_ms.saturating_sub(base_ms));
    let label = task_event_label(&event.kind);
    let mut summary = task_event_summary(event);
    if let Some(detail) = task_event_detail(event, width) {
        summary.push_str("  ");
        summary.push_str(&detail);
    }
    let line = format!("{elapsed:<8} {label:<12} {summary}");
    util::truncate_text(&line, width.saturating_sub(1).max(20))
}

fn task_event_label(kind: &str) -> &'static str {
    match kind {
        "task.created" => "created",
        "task.event" => "created",
        "task.queued" => "queued",
        "task.started" => "started",
        "task.cancel.requested" => "cancel",
        "task.cancelled" => "cancelled",
        "task.recovered" => "recovered",
        "engine.completed" => "engine",
        "engine.failed" => "failed",
        "engine.operation" => "operation",
        "engine.branch.operation" => "branch op",
        "agent.run.started" => "agent start",
        "agent.run.event" => "agent event",
        "agent.run" => "agent",
        "agent.branch.run.started" => "branch start",
        "agent.branch.run.event" => "branch event",
        "agent.branch.run" => "branch agent",
        _ => "event",
    }
}

fn task_event_summary(event: &AssistantTaskEvent) -> String {
    match event.kind.as_str() {
        "task.created" => event.message.clone(),
        "task.event" if event.message == "created from assistant message" => {
            "task created".to_string()
        }
        "task.queued" => "waiting for an execution slot".to_string(),
        "task.started" => "execution started".to_string(),
        "task.recovered" => "interrupted task was marked failed".to_string(),
        "engine.completed" => "engine completed".to_string(),
        "engine.failed" => "engine failed".to_string(),
        "engine.operation" if !event.message.is_empty() => event.message.clone(),
        "engine.operation" => event
            .operation
            .map(|operation| format!("{operation:?} step"))
            .unwrap_or_else(|| "engine step".to_string()),
        "engine.branch.operation" if !event.message.is_empty() => event.message.clone(),
        "engine.branch.operation" => event
            .operation
            .map(|operation| format!("{operation:?} branch step"))
            .unwrap_or_else(|| "branch step".to_string()),
        "agent.run.started" => "agent run started".to_string(),
        "agent.run.event" if !event.message.is_empty() => event.message.clone(),
        "agent.run.event" => "agent run event".to_string(),
        "agent.branch.run.started" => "branch agent run started".to_string(),
        "agent.branch.run.event" if !event.message.is_empty() => event.message.clone(),
        "agent.branch.run.event" => "branch agent run event".to_string(),
        "agent.run" if !event.message.is_empty() => event.message.clone(),
        "agent.run" => event
            .operation
            .map(|operation| format!("{operation:?} agent run"))
            .unwrap_or_else(|| "agent run".to_string()),
        "agent.branch.run" if !event.message.is_empty() => event.message.clone(),
        "agent.branch.run" => event
            .operation
            .map(|operation| format!("{operation:?} branch agent run"))
            .unwrap_or_else(|| "branch agent run".to_string()),
        "task.cancel.requested" => "cancel requested".to_string(),
        "task.cancelled" => "task cancelled".to_string(),
        _ => event.message.clone(),
    }
}

fn task_event_detail(event: &AssistantTaskEvent, width: usize) -> Option<String> {
    let payload = &event.payload;
    let detail = match event.kind.as_str() {
        "task.queued" => Some(format!(
            "running={} queued={} max={}",
            json_u64(payload, "running_tasks").unwrap_or_default(),
            json_u64(payload, "queued_tasks").unwrap_or_default(),
            json_u64(payload, "max_parallel_tasks").unwrap_or_default()
        )),
        "task.started" => json_u64(payload, "running_tasks_before_start")
            .map(|count| format!("running_before={count}")),
        "engine.completed" => {
            let status = payload
                .get("status")
                .map(ToString::to_string)
                .unwrap_or_else(|| "unknown".to_string());
            Some(format!(
                "status={} agent_runs={} events={}",
                status.trim_matches('"'),
                json_u64(payload, "agent_run_count").unwrap_or_default(),
                json_u64(payload, "event_count").unwrap_or_default()
            ))
        }
        "engine.failed" => payload
            .get("error")
            .and_then(serde_json::Value::as_str)
            .map(|error| format!("error={}", util::truncate_text(error, detail_width(width)))),
        "engine.operation" => event.operation.map(|operation| {
            let node = event
                .node_id
                .map(|node_id| format!(" node={node_id}"))
                .unwrap_or_default();
            format!("op={operation:?}{node}")
        }),
        "engine.branch.operation" => event.operation.map(|operation| {
            let branch = json_u64(payload, "branch_root_node_id")
                .map(|node_id| format!(" branch={node_id}"))
                .unwrap_or_default();
            let local = json_u64(payload, "local_node_id")
                .map(|node_id| format!(" local={node_id}"))
                .unwrap_or_default();
            format!("op={operation:?}{branch}{local}")
        }),
        "agent.run.started" => {
            let terminal_tools = payload
                .get("terminal_tools")
                .and_then(serde_json::Value::as_array)
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_else(|| "-".to_string());
            let node = event
                .node_id
                .map(|node_id| format!(" node={node_id}"))
                .unwrap_or_default();
            let operation = event
                .operation
                .map(|operation| format!(" op={operation:?}"))
                .unwrap_or_default();
            Some(format!("terminal={terminal_tools}{operation}{node}"))
        }
        "agent.run.event" => {
            let event_name = payload
                .get("event")
                .and_then(|event| event.get("event"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-");
            let node = event
                .node_id
                .map(|node_id| format!(" node={node_id}"))
                .unwrap_or_default();
            let operation = event
                .operation
                .map(|operation| format!(" op={operation:?}"))
                .unwrap_or_default();
            Some(format!("event={event_name}{operation}{node}"))
        }
        "agent.branch.run.started" => {
            let terminal_tools = payload
                .get("terminal_tools")
                .and_then(serde_json::Value::as_array)
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_else(|| "-".to_string());
            let branch = json_u64(payload, "branch_root_node_id")
                .map(|node_id| format!(" branch={node_id}"))
                .unwrap_or_default();
            let local = json_u64(payload, "local_node_id")
                .map(|node_id| format!(" local={node_id}"))
                .unwrap_or_default();
            let operation = event
                .operation
                .map(|operation| format!(" op={operation:?}"))
                .unwrap_or_default();
            Some(format!(
                "terminal={terminal_tools}{operation}{branch}{local}"
            ))
        }
        "agent.branch.run.event" => {
            let event_name = payload
                .get("event")
                .and_then(|event| event.get("event"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-");
            let branch = json_u64(payload, "branch_root_node_id")
                .map(|node_id| format!(" branch={node_id}"))
                .unwrap_or_default();
            let local = json_u64(payload, "local_node_id")
                .map(|node_id| format!(" local={node_id}"))
                .unwrap_or_default();
            let operation = event
                .operation
                .map(|operation| format!(" op={operation:?}"))
                .unwrap_or_default();
            Some(format!("event={event_name}{operation}{branch}{local}"))
        }
        "agent.run" => {
            let terminal_tool = payload
                .get("terminal_tool")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-");
            let duration = json_u64(payload, "duration_ms")
                .map(|value| format!(" {}", duration_label(value)))
                .unwrap_or_default();
            let node = event
                .node_id
                .map(|node_id| format!(" node={node_id}"))
                .unwrap_or_default();
            let operation = event
                .operation
                .map(|operation| format!(" op={operation:?}"))
                .unwrap_or_default();
            Some(format!(
                "terminal={terminal_tool}{duration}{operation}{node}"
            ))
        }
        "agent.branch.run" => {
            let terminal_tool = payload
                .get("terminal_tool")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-");
            let duration = json_u64(payload, "duration_ms")
                .map(|value| format!(" {}", duration_label(value)))
                .unwrap_or_default();
            let branch = json_u64(payload, "branch_root_node_id")
                .map(|node_id| format!(" branch={node_id}"))
                .unwrap_or_default();
            let local = json_u64(payload, "local_node_id")
                .map(|node_id| format!(" local={node_id}"))
                .unwrap_or_default();
            let operation = event
                .operation
                .map(|operation| format!(" op={operation:?}"))
                .unwrap_or_default();
            Some(format!(
                "terminal={terminal_tool}{duration}{operation}{branch}{local}"
            ))
        }
        _ if event.kind != "task.event" && event.kind != "task.created" => {
            Some(format!("source={}", event.source))
        }
        _ => None,
    }?;
    Some(util::truncate_text(&detail, detail_width(width)))
}

fn format_agent_event_line(
    event: &crate::harness::task_view::AgentEventEntry,
    ordinal: usize,
    width: usize,
) -> String {
    let label = agent_event_label(event.event.as_deref());
    let summary = agent_event_summary(event, width);
    let line = format!(
        "run{:<3} #{:<4} {:<12} {}",
        event.run_index, ordinal, label, summary
    );
    util::truncate_text(&line, width.saturating_sub(1).max(20))
}

fn agent_event_label(event: Option<&str>) -> &'static str {
    match event {
        Some("tool_call_start") => "tool start",
        Some("tool_call_end") => "tool done",
        Some("tool_call_error") => "tool error",
        Some("usage") => "usage",
        Some("error") => "error",
        Some("step") => "step",
        Some("message") => "message",
        _ => "agent event",
    }
}

fn agent_event_summary(event: &crate::harness::task_view::AgentEventEntry, width: usize) -> String {
    let mut parts = vec![format!("{:?}", event.operation)];
    if let Some(source) = event.source.as_deref() {
        parts.push(format!("src={source}"));
    }
    if let Some(name) = event.name.as_deref() {
        parts.push(name.to_string());
    }
    if let Some(elapsed_ms) = event.elapsed_ms {
        parts.push(duration_label(elapsed_ms));
    }
    if let Some(objective) = event.objective.as_deref()
        && width >= 72
    {
        parts.push(util::truncate_text(objective, detail_width(width)));
    }
    if matches!(
        event.event.as_deref(),
        Some("error") | Some("tool_call_error")
    ) && let Some(message) =
        json_string(&event.record, "message").or_else(|| json_string(&event.record, "error"))
    {
        parts.push(format!(
            "error={}",
            util::truncate_text(&message, detail_width(width))
        ));
    }
    util::truncate_text(&parts.join(" "), detail_width(width).max(20))
}

fn elapsed_label(elapsed_ms: u64) -> String {
    if elapsed_ms < 1_000 {
        return format!("+{elapsed_ms}ms");
    }
    format!("+{}", duration_label(elapsed_ms))
}

fn duration_label(ms: u64) -> String {
    if ms < 1_000 {
        return format!("{ms}ms");
    }
    let seconds = ms / 1_000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let seconds = seconds % 60;
    if minutes < 60 {
        return format!("{minutes}m{seconds:02}s");
    }
    let hours = minutes / 60;
    let minutes = minutes % 60;
    format!("{hours}h{minutes:02}m")
}

fn detail_width(width: usize) -> usize {
    width.saturating_sub(36).clamp(16, 96)
}

fn json_u64(value: &serde_json::Value, key: &str) -> Option<u64> {
    value.get(key).and_then(serde_json::Value::as_u64)
}

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

fn status_label(status: &AssistantTaskStatus) -> &'static str {
    match status {
        AssistantTaskStatus::Created => "created",
        AssistantTaskStatus::Queued => "queued ",
        AssistantTaskStatus::Running => "running",
        AssistantTaskStatus::WaitingForInput => "waiting",
        AssistantTaskStatus::Completed => "done   ",
        AssistantTaskStatus::Failed => "failed ",
        AssistantTaskStatus::Cancelled => "cancel ",
    }
}

fn status_style(status: &AssistantTaskStatus) -> Style {
    let color = match status {
        AssistantTaskStatus::Created | AssistantTaskStatus::Queued => Color::Yellow,
        AssistantTaskStatus::Running => Color::Cyan,
        AssistantTaskStatus::WaitingForInput => Color::Blue,
        AssistantTaskStatus::Completed => Color::Green,
        AssistantTaskStatus::Failed => Color::Red,
        AssistantTaskStatus::Cancelled => Color::Magenta,
    };
    Style::default().fg(color)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MemoryTaskStore, NodeOperation};
    use serde_json::json;

    fn event(
        seq: u64,
        kind: &str,
        message: &str,
        payload: serde_json::Value,
    ) -> AssistantTaskEvent {
        AssistantTaskEvent {
            seq,
            timestamp_ms: 1_000 + seq,
            level: "INFO".to_string(),
            kind: kind.to_string(),
            source: "task.board".to_string(),
            message: message.to_string(),
            node_id: None,
            operation: None,
            payload,
        }
    }

    fn agent_run_event(seq: u64, event: &str, name: Option<&str>) -> AssistantTaskEvent {
        let mut payload_event = json!({
            "source": "agent-loop",
            "event": event,
        });
        if let Some(name) = name {
            payload_event["name"] = json!(name);
        }
        AssistantTaskEvent {
            seq,
            timestamp_ms: 1_000 + seq,
            level: "INFO".to_string(),
            kind: "agent.run.event".to_string(),
            source: "agent".to_string(),
            message: event.to_string(),
            node_id: Some(3),
            operation: Some(NodeOperation::Execute),
            payload: json!({
                "node_id": 3,
                "operation": "Execute",
                "event": payload_event,
            }),
        }
    }

    fn task_with_events(events: Vec<AssistantTaskEvent>) -> AssistantTask {
        let mut store = MemoryTaskStore::new();
        let task_id = store.create_task("run visible task".to_string());
        let mut task = store.get_task(&task_id).expect("task").clone();
        task.created_at_ms = 1_000;
        task.events = events;
        task
    }

    #[test]
    fn task_timeline_line_summarizes_queue_payload() {
        let line = format_task_event_line(
            &event(
                2,
                "task.queued",
                "queued on task board",
                json!({
                    "max_parallel_tasks": 2,
                    "running_tasks": 0,
                    "queued_tasks": 1,
                }),
            ),
            1_000,
            80,
        );
        assert!(line.contains("queued"));
        assert!(line.contains("waiting for an execution slot"));
        assert!(line.contains("running=0 queued=1 max=2"));
        assert!(!line.contains("payload"));
    }

    #[test]
    fn task_timeline_line_summarizes_recovery_without_raw_timestamp() {
        let line = format_task_event_line(
            &event(
                4,
                "task.recovered",
                "marked interrupted active task as failed on startup",
                serde_json::Value::Null,
            ),
            1_000,
            64,
        );
        assert!(line.contains("+4ms"));
        assert!(line.contains("recovered"));
        assert!(line.contains("interrupted task was marked failed"));
        assert!(!line.contains("178"));
    }

    #[test]
    fn task_timeline_groups_consecutive_agent_run_events() {
        let task = task_with_events(vec![
            agent_run_event(1, "tool_call_start", Some("Read")),
            agent_run_event(2, "tool_call_end", Some("Read")),
            agent_run_event(3, "usage", None),
            event(
                4,
                "agent.run",
                "done",
                json!({"terminal_tool": "submit_work"}),
            ),
        ]);

        let lines = format_task_timeline_lines(&task, 100);

        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("agent events"));
        assert!(lines[0].contains("3 events"));
        assert!(lines[0].contains("tool_start=1"));
        assert!(lines[0].contains("tool_done=1"));
        assert!(lines[0].contains("usage=1"));
        assert!(lines[0].contains("tools=Read"));
        assert!(lines[0].contains("node=3"));
        assert!(lines[1].contains("agent"));
    }

    #[test]
    fn task_timeline_keeps_agent_run_errors_visible() {
        let task = task_with_events(vec![
            agent_run_event(1, "tool_call_start", Some("Bash")),
            agent_run_event(2, "error", None),
            agent_run_event(3, "tool_call_end", Some("Bash")),
        ]);

        let lines = format_task_timeline_lines(&task, 100);

        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("agent events"));
        assert!(lines[1].contains("agent event"));
        assert!(lines[1].contains("error"));
        assert!(lines[2].contains("agent events"));
    }

    #[test]
    fn agent_timeline_line_summarizes_tool_event() {
        let line = format_agent_event_line(
            &crate::harness::task_view::AgentEventEntry {
                task_id: "task_1".to_string(),
                run_index: 1,
                event_index: 2,
                node_id: 1,
                operation: NodeOperation::Execute,
                source: Some("agent-loop".to_string()),
                event: Some("tool_call_start".to_string()),
                name: Some("Read".to_string()),
                elapsed_ms: Some(1_250),
                objective: None,
                record: json!({"event": "tool_call_start", "name": "Read"}),
            },
            2,
            80,
        );
        assert!(line.contains("tool start"));
        assert!(line.contains("Execute"));
        assert!(line.contains("Read"));
        assert!(line.contains("1s"));
    }
}
