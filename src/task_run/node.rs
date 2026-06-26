use crate::workspace::{WorkspaceChange, WorkspaceRequirement};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use std::fmt;

use super::{ArtifactId, Budget, CapabilityProfile, NodeId, NodeStatus, ProblemKey};

#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Serialize, Deserialize, JsonSchema,
)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum WorkSize {
    Tiny,
    #[default]
    Small,
    Medium,
    Large,
    XLarge,
}

impl fmt::Display for WorkSize {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Self::Tiny => "tiny",
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
            Self::XLarge => "xlarge",
        })
    }
}

/// The type of work a node performs.
///
/// Task types categorize nodes by their fundamental mode of operation.
/// Each task type is associated with a [`PolicyPack`] that defines the
/// planning engine's behavior for that type, replacing the old approach
/// where a single `policy` field directly encoded both the task category
/// and its planning behavior.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    /// Investigation, research, or evidence gathering.
    #[default]
    Explore,
    /// Code or artifact implementation and construction.
    Exploit,
    /// Polish, optimization, or iterative improvement.
    Refine,
    /// Verification, testing, or acceptance checking.
    Verify,
}

impl fmt::Display for TaskType {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Self::Explore => "explore",
            Self::Exploit => "exploit",
            Self::Refine => "refine",
            Self::Verify => "verify",
        })
    }
}

/// A Policy Pack defines the planning engine's behavior for a given task type.
///
/// Different task types can have different planning policies — for example,
/// an "explore" task might decompose at a larger size threshold than an
/// "exploit" task, or a "verify" task might never decompose at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PolicyPack {
    /// Whether this task type encourages recursive decomposition.
    pub decompose: bool,
    /// The size threshold above which the engine automatically enters
    /// NeedsPlanning. Tasks below this threshold execute directly.
    pub auto_plan_threshold: WorkSize,
}

impl TaskType {
    /// Returns the default [`PolicyPack`] for this task type.
    ///
    /// These defaults are chosen to be broadly useful:
    ///
    /// | TaskType  | decompose | auto_plan_threshold |
    /// |-----------|-----------|---------------------|
    /// | Explore   | true      | Large               |
    /// | Exploit   | true      | Medium              |
    /// | Refine    | false     | Large               |
    /// | Verify    | false     | Large               |
    ///
    /// - **Explore** tasks (investigation, research) decompose at Large+
    ///   because exploration often benefits from splitting into focused
    ///   sub-questions, but small explorations are fine as direct executes.
    /// - **Exploit** tasks (implementation, construction) decompose at Medium+
    ///   because implementation work above medium complexity benefits from
    ///   planning before executing.
    /// - **Refine** tasks (polish, iteration) never auto-decompose and
    ///   only plan at Large+, since refinement is normally a focused pass.
    /// - **Verify** tasks (testing, acceptance) never auto-decompose and
    ///   only plan at Large+, since verification is a single judgement pass.
    pub fn default_policy_pack(&self) -> PolicyPack {
        match self {
            Self::Explore => PolicyPack {
                decompose: true,
                auto_plan_threshold: WorkSize::Large,
            },
            Self::Exploit => PolicyPack {
                decompose: true,
                auto_plan_threshold: WorkSize::Medium,
            },
            Self::Refine => PolicyPack {
                decompose: false,
                auto_plan_threshold: WorkSize::Large,
            },
            Self::Verify => PolicyPack {
                decompose: false,
                auto_plan_threshold: WorkSize::Large,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum NodePolicy {
    /// Investigation, research, or evidence gathering.
    #[default]
    Explore,
    /// Code or artifact implementation and construction.
    Implement,
    /// Review, audit, or inspection of existing work.
    Review,
    /// Verification, testing, or acceptance checking.
    Verify,
    /// Decomposition, planning, or routing to sub-problems.
    Decompose,
}

impl fmt::Display for NodePolicy {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Self::Explore => "explore",
            Self::Implement => "implement",
            Self::Review => "review",
            Self::Verify => "verify",
            Self::Decompose => "decompose",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ScopeAssessment {
    pub next: String,
    pub size: WorkSize,
    pub reason: String,
}

impl ScopeAssessment {
    pub fn new(next: impl Into<String>, size: WorkSize, reason: impl Into<String>) -> Self {
        Self {
            next: next.into(),
            size,
            reason: reason.into(),
        }
    }
}

impl fmt::Display for ScopeAssessment {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "[{}] {} — {}", self.size, self.next, self.reason)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NodePlan {
    Execute,
    NeedsPlanning,
    Group(PlanGroup),
}

impl fmt::Display for NodePlan {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Self::Execute => "Execute",
            Self::NeedsPlanning => "NeedsPlanning",
            Self::Group(_) => "Group",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PlanGroup {
    pub mode: PlanGroupMode,
    pub items: Vec<NodeTemplate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum PlanGroupMode {
    Stage,
    Parallel,
}

impl fmt::Display for PlanGroupMode {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Self::Stage => "stage",
            Self::Parallel => "parallel",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NodeTemplate {
    pub key: ProblemKey,
    pub intent: String,
    pub size: WorkSize,
    pub scope_assessment: Option<ScopeAssessment>,
    pub workspace: WorkspaceRequirement,
    pub capabilities: CapabilityProfile,
    pub budget: Budget,
    pub policy: NodePolicy,
    pub task_type: TaskType,
    pub plan: NodePlan,
}

impl NodeTemplate {
    pub fn memory_leaf(key: &str, output: &str) -> Self {
        Self {
            key: ProblemKey(key.to_string()),
            intent: output.to_string(),
            size: WorkSize::Small,
            scope_assessment: None,
            workspace: WorkspaceRequirement::memory(),
            capabilities: CapabilityProfile::read_only(),
            budget: Budget::default(),
            policy: NodePolicy::Explore,
            task_type: TaskType::Explore,
            plan: NodePlan::Execute,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProblemNode {
    pub id: NodeId,
    pub key: ProblemKey,
    pub parent: Option<NodeId>,
    pub intent: String,
    pub size: WorkSize,
    pub scope_assessment: Option<ScopeAssessment>,
    pub workspace: WorkspaceRequirement,
    pub capabilities: CapabilityProfile,
    pub budget: Budget,
    pub policy: NodePolicy,
    pub children: Vec<NodeId>,
    pub task_type: TaskType,
    pub status: NodeStatus,
    pub plan: NodePlan,
    pub candidate: Option<ArtifactId>,
    pub accepted_artifact: Option<ArtifactId>,
    pub execution_attempts: u32,
    pub verification_attempts: u32,
    pub last_verdict_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactContentKind {
    Text,
    Json,
    Yaml,
    Markdown,
    Patch,
}

impl fmt::Display for ArtifactContentKind {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Self::Text => "text",
            Self::Json => "json",
            Self::Yaml => "yaml",
            Self::Markdown => "markdown",
            Self::Patch => "patch",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    pub id: ArtifactId,
    pub node_id: NodeId,
    pub content_kind: ArtifactContentKind,
    pub text: String,
    pub workspace_change: Option<WorkspaceChange>,
    pub children: Vec<ArtifactId>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Budget;
    use crate::CapabilityProfile;
    use crate::workspace::WorkspaceRequirement;

    #[test]
    fn scope_assessment_new_sets_all_fields() {
        let assessment = ScopeAssessment::new(
            "Implement feature X",
            WorkSize::Medium,
            "Requires new module",
        );
        assert_eq!(assessment.next, "Implement feature X");
        assert_eq!(assessment.size, WorkSize::Medium);
        assert_eq!(assessment.reason, "Requires new module");
    }

    #[test]
    fn scope_assessment_new_with_tiny_size() {
        let assessment = ScopeAssessment::new("Fix typo", WorkSize::Tiny, "One line change");
        assert_eq!(assessment.size, WorkSize::Tiny);
    }

    #[test]
    fn scope_assessment_new_with_large_size() {
        let assessment =
            ScopeAssessment::new("Big refactor", WorkSize::Large, "Multiple modules affected");
        assert_eq!(assessment.size, WorkSize::Large);
    }

    #[test]
    fn scope_assessment_new_with_xlarge_size() {
        let assessment =
            ScopeAssessment::new("Architecture change", WorkSize::XLarge, "Core redesign");
        assert_eq!(assessment.size, WorkSize::XLarge);
    }

    #[test]
    fn work_size_default_is_small() {
        assert_eq!(WorkSize::default(), WorkSize::Small);
    }

    #[test]
    fn node_template_memory_leaf_creates_execute_plan() {
        let template = NodeTemplate::memory_leaf("test-key", "do something");
        assert_eq!(template.key, ProblemKey("test-key".to_string()));
        assert_eq!(template.intent, "do something");
        assert_eq!(template.size, WorkSize::Small);
        assert_eq!(template.plan, NodePlan::Execute);
    }

    #[test]
    fn node_template_memory_leaf_uses_memory_workspace() {
        let template = NodeTemplate::memory_leaf("key", "intent");
        assert_eq!(template.workspace, WorkspaceRequirement::memory());
    }

    #[test]
    fn node_template_memory_leaf_uses_read_only_capabilities() {
        let template = NodeTemplate::memory_leaf("key", "intent");
        assert_eq!(template.capabilities, CapabilityProfile::read_only());
    }

    #[test]
    fn node_template_memory_leaf_has_default_budget() {
        let template = NodeTemplate::memory_leaf("key", "intent");
        assert_eq!(template.budget, Budget::default());
    }

    #[test]
    fn node_template_memory_leaf_scope_assessment_is_none() {
        let template = NodeTemplate::memory_leaf("key", "intent");
        assert!(template.scope_assessment.is_none());
    }

    #[test]
    fn plan_group_mode_variants_are_distinct() {
        assert_ne!(PlanGroupMode::Stage, PlanGroupMode::Parallel);
    }

    #[test]
    fn node_plan_variants_are_distinct() {
        assert_ne!(NodePlan::Execute, NodePlan::NeedsPlanning);
        assert_ne!(
            NodePlan::NeedsPlanning,
            NodePlan::Group(PlanGroup {
                mode: PlanGroupMode::Stage,
                items: vec![],
            })
        );
    }

    #[test]
    fn plan_group_holds_items() {
        let items = vec![
            NodeTemplate::memory_leaf("a", "first"),
            NodeTemplate::memory_leaf("b", "second"),
        ];
        let group = PlanGroup {
            mode: PlanGroupMode::Parallel,
            items: items.clone(),
        };
        assert_eq!(group.mode, PlanGroupMode::Parallel);
        assert_eq!(group.items.len(), 2);
        assert_eq!(group.items[0].key, ProblemKey("a".to_string()));
        assert_eq!(group.items[1].key, ProblemKey("b".to_string()));
    }

    #[test]
    fn plan_group_stage_mode() {
        let group = PlanGroup {
            mode: PlanGroupMode::Stage,
            items: vec![NodeTemplate::memory_leaf("first", "step 1")],
        };
        assert_eq!(group.mode, PlanGroupMode::Stage);
    }

    #[test]
    fn scope_assessment_serde_roundtrip() {
        let original = ScopeAssessment::new("test", WorkSize::Large, "because");
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: ScopeAssessment = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn work_size_serde_roundtrip() {
        for size in [
            WorkSize::Tiny,
            WorkSize::Small,
            WorkSize::Medium,
            WorkSize::Large,
            WorkSize::XLarge,
        ] {
            let json = serde_json::to_string(&size).unwrap();
            let deserialized: WorkSize = serde_json::from_str(&json).unwrap();
            assert_eq!(size, deserialized);
        }
    }

    #[test]
    fn plan_group_mode_serde_roundtrip() {
        for mode in [PlanGroupMode::Stage, PlanGroupMode::Parallel] {
            let json = serde_json::to_string(&mode).unwrap();
            let deserialized: PlanGroupMode = serde_json::from_str(&json).unwrap();
            assert_eq!(mode, deserialized);
        }
    }

    #[test]
    fn node_plan_serde_roundtrip() {
        let plans = vec![
            NodePlan::Execute,
            NodePlan::NeedsPlanning,
            NodePlan::Group(PlanGroup {
                mode: PlanGroupMode::Parallel,
                items: vec![NodeTemplate::memory_leaf("k", "v")],
            }),
        ];
        for plan in plans {
            let json = serde_json::to_string(&plan).unwrap();
            let deserialized: NodePlan = serde_json::from_str(&json).unwrap();
            assert_eq!(plan, deserialized);
        }
    }

    #[test]
    fn problem_key_newtype_wraps_string() {
        let key = ProblemKey("hello".to_string());
        assert_eq!(key.0, "hello");
        assert_eq!(format!("{:?}", key), "ProblemKey(\"hello\")");
    }

    #[test]
    fn work_size_display_is_readable() {
        assert_eq!(format!("{}", WorkSize::Tiny), "tiny");
        assert_eq!(format!("{}", WorkSize::Small), "small");
        assert_eq!(format!("{}", WorkSize::Medium), "medium");
        assert_eq!(format!("{}", WorkSize::Large), "large");
        assert_eq!(format!("{}", WorkSize::XLarge), "xlarge");
    }

    #[test]
    fn node_plan_display_is_readable() {
        assert_eq!(format!("{}", NodePlan::Execute), "Execute");
        assert_eq!(format!("{}", NodePlan::NeedsPlanning), "NeedsPlanning");
        assert_eq!(
            format!(
                "{}",
                NodePlan::Group(PlanGroup {
                    mode: PlanGroupMode::Parallel,
                    items: vec![],
                })
            ),
            "Group"
        );
    }

    #[test]
    fn plan_group_mode_display_is_readable() {
        assert_eq!(format!("{}", PlanGroupMode::Stage), "stage");
        assert_eq!(format!("{}", PlanGroupMode::Parallel), "parallel");
    }

    #[test]
    fn scope_assessment_display_includes_size_next_and_reason() {
        let sa = ScopeAssessment::new("Add tests", WorkSize::Small, "Improve coverage");
        let display = format!("{}", sa);
        assert!(display.contains("small"), "expected small in '{}'", display);
        assert!(
            display.contains("Add tests"),
            "expected 'Add tests' in '{}'",
            display
        );
        assert!(
            display.contains("Improve coverage"),
            "expected 'Improve coverage' in '{}'",
            display
        );
    }

    #[test]
    fn artifact_content_kind_display_is_readable() {
        assert_eq!(format!("{}", ArtifactContentKind::Text), "text");
        assert_eq!(format!("{}", ArtifactContentKind::Json), "json");
        assert_eq!(format!("{}", ArtifactContentKind::Yaml), "yaml");
        assert_eq!(format!("{}", ArtifactContentKind::Markdown), "markdown");
        assert_eq!(format!("{}", ArtifactContentKind::Patch), "patch");
    }
}
