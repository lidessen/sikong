use schemars::JsonSchema;
use serde::Deserialize;

use crate::{AgentToolSpec, FailureClass, NodeOperationOutput, NodeTemplate, VerificationVerdict};

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct EngineTools;

#[siko_macros::toolset(
    enum_name = "EngineTool",
    output = "crate::NodeOperationOutput",
    fallback = "crate::NodeOperationOutput::Noop"
)]
impl EngineTools {
    #[tool(description = "Submit the normalized specification for this node.")]
    pub(crate) fn submit_specification(
        &self,
        _args: SubmitSpecificationArgs,
    ) -> NodeOperationOutput {
        NodeOperationOutput::Specified
    }

    #[tool(description = "Submit acquired information and supporting evidence.")]
    pub(crate) fn submit_evidence(&self, args: SubmitEvidenceArgs) -> NodeOperationOutput {
        NodeOperationOutput::Acquired {
            need: args.need,
            evidence: args.evidence,
            next_script: args.next_script,
        }
    }

    #[tool(description = "Submit child nodes for recursive execution.")]
    pub(crate) fn submit_division(&self, args: SubmitDivisionArgs) -> NodeOperationOutput {
        NodeOperationOutput::Divided {
            children: args.children,
        }
    }

    #[tool(description = "Submit the atomic work result and workspace effects.")]
    pub(crate) fn submit_work(&self, args: SubmitWorkArgs) -> NodeOperationOutput {
        NodeOperationOutput::Executed {
            output: args.output,
            changed_paths: args.changed_paths,
            side_effects: args.side_effects,
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

    #[tool(description = "Submit the final commit/report signal for the accepted node.")]
    pub(crate) fn submit_commit(&self, _args: SubmitCommitArgs) -> NodeOperationOutput {
        NodeOperationOutput::Committed
    }
}

pub(crate) fn read_operation_context_spec() -> AgentToolSpec {
    AgentToolSpec {
        name: "read_operation_context".to_string(),
        description: "Read the current operation context packet.".to_string(),
        input_schema: crate::tools::schema_for::<EmptyToolArgs>(),
    }
}

#[derive(Deserialize, JsonSchema)]
pub(crate) struct EmptyToolArgs {}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub(crate) struct SubmitSpecificationArgs {
    pub report: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub(crate) struct SubmitEvidenceArgs {
    pub need: String,
    pub evidence: String,
    pub next_script: crate::NodeScript,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub(crate) struct SubmitDivisionArgs {
    pub children: Vec<NodeTemplate>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub(crate) struct SubmitWorkArgs {
    pub output: String,
    pub changed_paths: Vec<String>,
    pub side_effects: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub(crate) struct SubmitCombinationArgs {
    pub output: String,
    pub resolved_conflicts: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub(crate) struct SubmitVerdictArgs {
    pub verdict: VerdictDecision,
    pub reason: String,
    pub failure_class: Option<crate::FailureClass>,
    pub missing_info: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[schemars(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub(crate) enum VerdictDecision {
    Accept,
    Reject,
    NeedInformation,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub(crate) struct SubmitCommitArgs {
    pub report: String,
}

impl SubmitVerdictArgs {
    fn into_verdict(self) -> VerificationVerdict {
        match self.verdict {
            VerdictDecision::Accept => VerificationVerdict::Accept,
            VerdictDecision::Reject => VerificationVerdict::Reject {
                failure_class: self.failure_class.unwrap_or(FailureClass::BadOutput),
                reason: self.reason,
            },
            VerdictDecision::NeedInformation => VerificationVerdict::Uncertain {
                missing_info: self.missing_info.unwrap_or_default(),
                reason: self.reason,
            },
        }
    }
}
