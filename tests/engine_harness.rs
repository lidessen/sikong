use serde_json::Value;
use siko::*;

mod support;
use support::RecordingAgentWorker;

#[tokio::test]
async fn engine_harness_sends_structured_context_packet_to_agent_loop() {
    let worker = RecordingAgentWorker::default();
    let recorder = worker.clone();
    let mut engine = Engine::new(MemoryWorkspace::default(), worker);
    let root = engine.insert_root(NodeTemplate::memory_leaf("polish", "polished text"));

    engine.run(root).await.unwrap();

    let requests = recorder.requests();
    let execute = requests
        .iter()
        .find(|request| request.terminal_tool_set == vec!["submit_work"])
        .expect("execute request");
    assert_eq!(execute.protocol_version, 1);
    assert_eq!(execute.kind, AgentRunKind::EngineOperation);
    assert!(prompt_contains(&execute.prompt, "atomic execution pass"));
    assert!(prompt_contains(&execute.prompt, "submit_work"));
    assert_eq!(execute.terminal_tool_set, vec!["submit_work"]);
    assert_eq!(
        execute
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["read_operation_context", "submit_work"]
    );

    let packet = parse_context_packet(execute);
    assert_eq!(packet["kind"], "engine_operation");
    assert_eq!(packet["operation"], "Execute");
    assert_eq!(packet["node"]["intent"], "polish");
    assert_eq!(packet["node"]["workspace"]["provider"], "Memory");
    assert_eq!(packet["node"]["allow_write"], false);
    assert!(packet["candidate"].is_null());
    assert_eq!(packet["child_artifacts"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn engine_harness_includes_candidate_child_and_integration_context() {
    let worker = RecordingAgentWorker::default();
    let recorder = worker.clone();
    let mut engine = Engine::new(Workspaces::default(), worker);
    let child_a = scoped_git_leaf("a", "patch a", "packages/client/src/api.ts");
    let child_b = scoped_git_leaf("b", "patch b", "packages/client/src/api.ts");
    let root = engine.insert_root(NodeTemplate {
        key: ProblemKey("combine".to_string()),
        intent: "combine patches".to_string(),
        workspace: WorkspaceRequirement::git(["packages/client/src/api.ts"]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        script: NodeScript::Divide {
            children: vec![child_a, child_b],
            combine_output: "combined patch".to_string(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    });

    engine.run(root).await.unwrap();

    let requests = recorder.requests();
    let combine = requests
        .iter()
        .find(|request| request.terminal_tool_set == vec!["submit_combination"])
        .expect("combine request");
    let packet = parse_context_packet(combine);
    assert_eq!(packet["operation"], "Combine");
    assert_eq!(packet["child_artifacts"].as_array().unwrap().len(), 2);
    let changed_paths = packet["workspace_integration"]["changed_paths"]
        .as_array()
        .unwrap();
    assert!(
        changed_paths
            .iter()
            .any(|path| path == "packages/client/src/api.ts")
    );
    assert_eq!(
        packet["workspace_integration"]["conflicts"][0],
        "packages/client/src/api.ts"
    );
}

#[test]
fn engine_harness_builds_operation_specific_prompt_tools_and_config() {
    let cases = [
        (
            NodeOperation::Specify,
            "submit_specification",
            "Node To Specify",
            "Normalize node",
            "report",
        ),
        (
            NodeOperation::Acquire,
            "submit_evidence",
            "Evidence Standard",
            "missing information",
            "evidence",
        ),
        (
            NodeOperation::Divide,
            "submit_division",
            "Decomposition Strategy",
            "child nodes",
            "children",
        ),
        (
            NodeOperation::Execute,
            "submit_work",
            "Workspace Rules",
            "Solve node",
            "changed_paths",
        ),
        (
            NodeOperation::Combine,
            "submit_combination",
            "Workspace Integration",
            "conflicts are present",
            "resolved_conflicts",
        ),
        (
            NodeOperation::Verify,
            "submit_verdict",
            "Verdict Standard",
            "Accept only when",
            "verdict",
        ),
        (
            NodeOperation::Commit,
            "submit_commit",
            "Report Standard",
            "final report signal",
            "report",
        ),
    ];

    for (operation, terminal_tool, expected_section, prompt_fragment, schema_field) in cases {
        let context = AgentOperationContext {
            node: problem_node(script_for_operation(operation)),
            operation,
            candidate: None,
            child_artifacts: Vec::new(),
            workspace_integration: None,
        };
        let expected_tools = vec!["read_operation_context", terminal_tool];
        let harness = OperationHarness::new(context);
        let request = harness.build_agent_run();

        assert_eq!(request.protocol_version, 1);
        assert_eq!(request.kind, AgentRunKind::EngineOperation);
        assert_eq!(request.objective, format!("{operation:?} node 1"));
        assert!(request.prompt.len() >= 5);
        assert!(prompt_section_exists(&request.prompt, "Role"));
        assert!(prompt_section_exists(&request.prompt, expected_section));
        assert!(prompt_section_exists(&request.prompt, "Completion"));
        assert!(prompt_contains(&request.prompt, prompt_fragment));
        assert!(prompt_contains(&request.prompt, "read_operation_context"));
        assert!(prompt_contains(&request.prompt, terminal_tool));
        assert_eq!(request.terminal_tool_set, vec![terminal_tool]);
        assert_eq!(
            EngineAgentHarness::terminal_tool_names(operation),
            vec![terminal_tool]
        );
        assert_eq!(harness.terminal_tool_names(), vec![terminal_tool]);
        assert_eq!(request.tool_choice, AgentToolChoice::Required);
        assert_eq!(
            request
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            expected_tools
        );

        let terminal_spec = request
            .tools
            .iter()
            .find(|tool| tool.name == terminal_tool)
            .expect("terminal tool spec");
        assert!(
            schema_has_property(&terminal_spec.input_schema, schema_field),
            "expected {operation:?} schema to contain {schema_field}: {}",
            terminal_spec.input_schema
        );
    }
}

#[test]
fn assistant_harness_builds_assistant_turn_prompt_tools_and_config() {
    let harness = AssistantHarness::new(AssistantContext {
        current_message: "status task_1".to_string(),
        active_task: Some("task_1".to_string()),
        tasks: vec![AssistantContextTask {
            id: "task_1".to_string(),
            title: "Analyze repo".to_string(),
            status: AssistantTaskStatus::Running,
        }],
    });
    let expected_tools = vec!["read_assistant_context", "submit_assistant_decision"];
    let request = harness.build_agent_run();

    assert_eq!(request.protocol_version, 1);
    assert_eq!(request.kind, AgentRunKind::AssistantTurn);
    assert_eq!(request.objective, "Assistant turn");
    assert_eq!(request.prompt.len(), 4);
    assert!(prompt_section_exists(&request.prompt, "Role"));
    assert!(prompt_section_exists(&request.prompt, "Decision Scope"));
    assert!(prompt_section_exists(&request.prompt, "Context"));
    assert!(prompt_section_exists(&request.prompt, "Completion"));
    assert!(prompt_contains(
        &request.prompt,
        "assistant-level coordinator"
    ));
    assert!(prompt_contains(&request.prompt, "read_assistant_context"));
    assert!(prompt_contains(
        &request.prompt,
        "submit_assistant_decision"
    ));
    assert_eq!(request.terminal_tool_set, vec!["submit_assistant_decision"]);
    assert_eq!(request.tool_choice, AgentToolChoice::Required);
    assert_eq!(
        request
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        expected_tools
    );

    let terminal_spec = request
        .tools
        .iter()
        .find(|tool| tool.name == "submit_assistant_decision")
        .expect("assistant terminal tool");
    assert!(schema_has_property(&terminal_spec.input_schema, "decision"));
    assert!(schema_has_property(&terminal_spec.input_schema, "response"));

    let packet = parse_context_packet(&request);
    assert_eq!(packet["kind"], "assistant_turn");
    assert_eq!(packet["current_message"], "status task_1");
    assert_eq!(packet["active_task"], "task_1");
    assert_eq!(packet["tasks"][0]["id"], "task_1");
    assert_eq!(packet["tasks"][0]["status"], "Running");
}

#[tokio::test]
async fn engine_harness_reports_protocol_violation_for_wrong_terminal_tool() {
    let mut harness = EngineAgentHarness;
    let context = AgentOperationContext {
        node: problem_node(NodeScript::Leaf {
            output: "output".to_string(),
            changed_paths: Vec::new(),
            side_effects: Vec::new(),
            verdicts: vec![VerificationVerdict::Accept],
        }),
        operation: NodeOperation::Execute,
        candidate: None,
        child_artifacts: Vec::new(),
        workspace_integration: None,
    };

    let result = harness.decode_result(
        &context,
        AgentWorkerResult {
            report: "done".to_string(),
            terminal_call: Some(AgentTerminalToolCall {
                name: "submit_verdict".to_string(),
                arguments: serde_json::json!({}),
            }),
        },
    );

    assert_eq!(result.output, NodeOperationOutput::Noop);
    assert_eq!(result.terminal_tool.as_deref(), Some("submit_verdict"));
    assert!(result.report.contains("protocol violation"));
}

fn parse_context_packet(request: &AgentRunRequest) -> Value {
    request.input.clone()
}

fn prompt_contains(prompt: &[AgentPromptSection], needle: &str) -> bool {
    prompt
        .iter()
        .any(|section| section.title.contains(needle) || section.content.contains(needle))
}

fn prompt_section_exists(prompt: &[AgentPromptSection], title: &str) -> bool {
    prompt.iter().any(|section| section.title == title)
}

fn schema_has_property(schema: &Value, property: &str) -> bool {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|properties| properties.contains_key(property))
}

fn script_for_operation(operation: NodeOperation) -> NodeScript {
    match operation {
        NodeOperation::Specify
        | NodeOperation::Execute
        | NodeOperation::Verify
        | NodeOperation::Commit => NodeScript::Leaf {
            output: "output".to_string(),
            changed_paths: Vec::new(),
            side_effects: Vec::new(),
            verdicts: vec![VerificationVerdict::Accept],
        },
        NodeOperation::Acquire => NodeScript::NeedsInfo {
            need: "missing input".to_string(),
            acquired: "evidence".to_string(),
            then: Box::new(NodeScript::Leaf {
                output: "output".to_string(),
                changed_paths: Vec::new(),
                side_effects: Vec::new(),
                verdicts: vec![VerificationVerdict::Accept],
            }),
        },
        NodeOperation::Divide | NodeOperation::Combine => NodeScript::Divide {
            children: vec![NodeTemplate::memory_leaf("child", "child output")],
            combine_output: "combined output".to_string(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    }
}

fn scoped_git_leaf(key: &str, output: &str, path: &str) -> NodeTemplate {
    NodeTemplate {
        key: ProblemKey(key.to_string()),
        intent: key.to_string(),
        workspace: WorkspaceRequirement::git([path]),
        capabilities: CapabilityProfile::writable(),
        budget: Budget::default(),
        script: NodeScript::Leaf {
            output: output.to_string(),
            changed_paths: vec![path.to_string()],
            side_effects: Vec::new(),
            verdicts: vec![VerificationVerdict::Accept],
        },
    }
}

fn problem_node(script: NodeScript) -> ProblemNode {
    ProblemNode {
        id: 1,
        key: ProblemKey("node".to_string()),
        parent: None,
        intent: "node".to_string(),
        workspace: WorkspaceRequirement::memory(),
        capabilities: CapabilityProfile::read_only(),
        budget: Budget::default(),
        dependencies: Vec::new(),
        children: Vec::new(),
        status: NodeStatus::New,
        script,
        acquired: Vec::new(),
        candidate: None,
        accepted_artifact: None,
        execution_attempts: 0,
        verification_attempts: 0,
    }
}
