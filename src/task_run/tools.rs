use schemars::JsonSchema;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::AgentToolSpec;

use super::{
    Budget, CapabilityProfile, FailureClass, NodeOperationOutput, NodePlan, NodeTemplate,
    PlanGroup, PlanGroupMode, ProblemKey, ScopeAssessment, VerificationVerdict, WorkShape,
    WorkSize,
};

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct EngineTools;

#[siko_macros::toolset(
    enum_name = "EngineTool",
    output = "crate::task_run::NodeOperationOutput"
)]
impl EngineTools {
    #[tool(
        description = "Submit the normalized scope assessment for this node. The engine decides the next plan."
    )]
    pub(crate) fn submit_specification(
        &self,
        args: SubmitSpecificationArgs,
    ) -> NodeOperationOutput {
        let SubmitSpecificationArgs {
            size,
            shape,
            reference_match,
            scope_signals,
            missing_info,
        } = args;
        NodeOperationOutput::Specified {
            scope_assessment: ScopeAssessment {
                size,
                shape,
                reference_match,
                scope_signals,
            },
            missing_info: normalize_optional_text(missing_info),
        }
    }

    #[tool(description = "Submit acquired information and supporting evidence.")]
    pub(crate) fn submit_evidence(&self, args: SubmitEvidenceArgs) -> NodeOperationOutput {
        NodeOperationOutput::Acquired {
            need: args.need,
            evidence: args.evidence,
        }
    }

    #[tool(description = "Submit a stage or parallel plan group for recursive execution.")]
    pub(crate) fn submit_plan_group(&self, args: SubmitPlanGroupArgs) -> NodeOperationOutput {
        NodeOperationOutput::Planned {
            group: PlanGroup {
                mode: args.mode,
                items: args
                    .items
                    .into_iter()
                    .enumerate()
                    .map(|(index, item)| item.into_node_template(index))
                    .collect(),
            },
        }
    }

    #[tool(description = "Submit the atomic work result.")]
    pub(crate) fn submit_work(&self, args: SubmitWorkArgs) -> NodeOperationOutput {
        NodeOperationOutput::Executed {
            output: args.output,
        }
    }

    #[tool(description = "Submit the combined result after integrating child artifacts.")]
    pub(crate) fn submit_combination(&self, args: SubmitCombinationArgs) -> NodeOperationOutput {
        NodeOperationOutput::Combined {
            output: args.output,
        }
    }

    #[tool(description = "Submit the verification verdict for the candidate artifact.")]
    pub(crate) fn submit_verdict(&self, args: SubmitVerdictArgs) -> NodeOperationOutput {
        NodeOperationOutput::Verified {
            verdict: args.into_verdict(),
        }
    }
}

pub(crate) fn read_operation_context_spec() -> AgentToolSpec {
    AgentToolSpec {
        name: "read_operation_context".to_string(),
        description: "Read the current operation context packet.".to_string(),
        input_schema: crate::agent_run::schema_for::<EmptyToolArgs>(),
    }
}

fn normalize_optional_text(input: Option<String>) -> Option<String> {
    input
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("null"))
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct EmptyToolArgs {}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitSpecificationArgs {
    pub size: WorkSize,
    pub shape: WorkShape,
    pub reference_match: String,
    pub scope_signals: Vec<String>,
    pub missing_info: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitEvidenceArgs {
    pub need: String,
    pub evidence: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitPlanGroupArgs {
    pub mode: PlanGroupMode,
    pub items: Vec<PlanItemInput>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct PlanItemInput {
    pub key: Option<String>,
    pub title: Option<String>,
    pub intent: Option<String>,
    pub description: Option<String>,
    pub verification: Option<String>,
    pub size: Option<WorkSize>,
    #[serde(default, deserialize_with = "deserialize_optional_work_shape")]
    pub shape: Option<WorkShape>,
    pub reference_match: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string_vec")]
    pub scope_signals: Option<Vec<String>>,
}

impl PlanItemInput {
    fn into_node_template(self, index: usize) -> NodeTemplate {
        let fallback_title = self
            .title
            .as_deref()
            .or(self.intent.as_deref())
            .or(self.description.as_deref())
            .unwrap_or("item");
        let key = self
            .key
            .unwrap_or_else(|| plan_item_key(fallback_title, index));
        let mut intent = self
            .intent
            .or(self.description)
            .or(self.title)
            .unwrap_or_else(|| format!("Complete plan item {}", index + 1));
        if let Some(verification) = self.verification {
            intent.push_str("\n\nAcceptance: ");
            intent.push_str(&verification);
        }

        let size = self.size.unwrap_or_default();
        let scope_assessment = self.reference_match.map(|reference_match| ScopeAssessment {
            size,
            shape: self.shape.unwrap_or_default(),
            reference_match,
            scope_signals: self.scope_signals.unwrap_or_default(),
        });

        NodeTemplate {
            key: ProblemKey(key),
            intent,
            size,
            scope_assessment,
            workspace: crate::workspace::WorkspaceRequirement::memory(),
            capabilities: CapabilityProfile::read_only(),
            budget: Budget::default(),
            plan: NodePlan::Execute,
        }
    }
}

fn plan_item_key(input: &str, index: usize) -> String {
    let mut key = String::new();
    let mut last_dash = false;
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            key.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !key.is_empty() {
            key.push('-');
            last_dash = true;
        }
    }
    while key.ends_with('-') {
        key.pop();
    }
    if key.is_empty() {
        format!("item-{}", index + 1)
    } else {
        key
    }
}

fn deserialize_optional_work_shape<'de, D>(deserializer: D) -> Result<Option<WorkShape>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(parse_work_shape(&value)),
        Some(other) => serde_json::from_value(other).ok(),
    })
}

fn parse_work_shape(value: &str) -> WorkShape {
    match value
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_")
        .as_str()
    {
        "atomic" => WorkShape::Atomic,
        "phased" => WorkShape::Phased,
        "independent_areas" | "independent_area" => WorkShape::IndependentAreas,
        "unknown" => WorkShape::Unknown,
        _ => WorkShape::Unknown,
    }
}

fn deserialize_optional_string_vec<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(non_empty_strings([value])),
        Some(Value::Array(values)) => Some(non_empty_strings(
            values
                .into_iter()
                .filter_map(|value| match value {
                    Value::String(value) => Some(value),
                    other => Some(other.to_string()),
                })
                .collect::<Vec<_>>(),
        )),
        Some(other) => Some(non_empty_strings([other.to_string()])),
    }
    .filter(|values| !values.is_empty()))
}

fn non_empty_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitWorkArgs {
    pub output: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitCombinationArgs {
    pub output: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitVerdictArgs {
    pub verdict: VerdictDecision,
    pub reason: String,
    pub failure_class: Option<String>,
    pub missing_info: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub(crate) enum VerdictDecision {
    Accept,
    Reject,
    NeedInformation,
}

impl SubmitVerdictArgs {
    fn into_verdict(self) -> VerificationVerdict {
        match self.verdict {
            VerdictDecision::Accept => VerificationVerdict::Accept,
            VerdictDecision::Reject => VerificationVerdict::Reject {
                failure_class: self
                    .failure_class
                    .as_deref()
                    .and_then(parse_failure_class)
                    .unwrap_or(FailureClass::BadOutput),
                reason: self.reason,
            },
            VerdictDecision::NeedInformation => VerificationVerdict::Uncertain {
                missing_info: self.missing_info.unwrap_or_default(),
                reason: self.reason,
            },
        }
    }
}

fn parse_failure_class(input: &str) -> Option<FailureClass> {
    match input {
        "missing_info" | "MissingInfo" => Some(FailureClass::MissingInfo),
        "spec_ambiguity" | "SpecAmbiguity" => Some(FailureClass::SpecAmbiguity),
        "incomplete_output" | "incomplete_assessment" | "IncompleteOutput" => {
            Some(FailureClass::IncompleteOutput)
        }
        "bad_output" | "BadOutput" => Some(FailureClass::BadOutput),
        "unsafe_side_effect" | "UnsafeSideEffect" => Some(FailureClass::UnsafeSideEffect),
        "merge_conflict" | "MergeConflict" => Some(FailureClass::MergeConflict),
        "budget_exhausted" | "BudgetExhausted" => Some(FailureClass::BudgetExhausted),
        _ => None,
    }
}
