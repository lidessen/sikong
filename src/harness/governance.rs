use crate::core::task_run::NodeOperation;

/// Governance layer enum identifying which authority layer applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum GovernanceLayer {
    Arch,
    Plan,
    Execute,
    Verify,
}

/// Governance gate enum — prompt-level identifiers for hard gate violations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GovernanceGate {
    ArchEscape,
    ScopeWiden,
    ParallelDependency,
    SynthesisChild,
    UnsupportedFact,
    PassWithHardViolation,
    Protocol,
    CheckFail,
}

impl GovernanceGate {
    pub fn id(self) -> &'static str {
        match self {
            Self::ArchEscape => "G-ARCH-ESCAPE",
            Self::ScopeWiden => "G-SCOPE-WIDEN",
            Self::ParallelDependency => "G-PARALLEL-DEPENDENCY",
            Self::SynthesisChild => "G-SYNTHESIS-CHILD",
            Self::UnsupportedFact => "G-UNSUPPORTED-FACT",
            Self::PassWithHardViolation => "G-PASS-WITH-HARD-VIOLATION",
            Self::Protocol => "G-PROTOCOL",
            Self::CheckFail => "G-CHECK-FAIL",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::ArchEscape => {
                "Local work modifies Arch-owned contracts without explicit authority."
            }
            Self::ScopeWiden => "A child workspace scope widens beyond the parent scope.",
            Self::ParallelDependency => {
                "A parallel plan item depends on sibling output; ordered dependencies must be staged."
            }
            Self::SynthesisChild => {
                "A parallel plan creates a child only to synthesize sibling findings; parent Combine owns synthesis."
            }
            Self::UnsupportedFact => {
                "Combine introduces facts not present in accepted child artifacts or parent context."
            }
            Self::PassWithHardViolation => {
                "Verify returns accept while listing a hard gate violation."
            }
            Self::Protocol => "The agent run violates the terminal tool or payload protocol.",
            Self::CheckFail => "A deterministic check required for acceptance failed.",
        }
    }
}

impl std::fmt::Display for GovernanceLayer {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(match self {
            Self::Arch => "Arch",
            Self::Plan => "Plan",
            Self::Execute => "Execute",
            Self::Verify => "Verify",
        })
    }
}

impl std::fmt::Display for GovernanceGate {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(self.id())
    }
}

/// Returns the governance layer for a given node operation.
pub fn governance_layer_for(op: NodeOperation) -> Option<GovernanceLayer> {
    match op {
        NodeOperation::Specify | NodeOperation::Plan => Some(GovernanceLayer::Plan),
        NodeOperation::Execute | NodeOperation::Combine => Some(GovernanceLayer::Execute),
        NodeOperation::Verify => Some(GovernanceLayer::Verify),
        NodeOperation::Commit => None,
    }
}

/// Returns the active hard gates for a given node operation.
pub fn active_hard_gates_for(op: NodeOperation) -> Vec<GovernanceGate> {
    match op {
        NodeOperation::Specify => vec![],
        NodeOperation::Plan => vec![
            GovernanceGate::ArchEscape,
            GovernanceGate::ParallelDependency,
            GovernanceGate::SynthesisChild,
            GovernanceGate::ScopeWiden,
            GovernanceGate::Protocol,
        ],
        NodeOperation::Execute => vec![
            GovernanceGate::ArchEscape,
            GovernanceGate::ScopeWiden,
            GovernanceGate::Protocol,
            GovernanceGate::CheckFail,
        ],
        NodeOperation::Combine => vec![
            GovernanceGate::UnsupportedFact,
            GovernanceGate::Protocol,
            GovernanceGate::CheckFail,
        ],
        NodeOperation::Verify => vec![
            GovernanceGate::PassWithHardViolation,
            GovernanceGate::Protocol,
            GovernanceGate::CheckFail,
        ],
        NodeOperation::Commit => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_governance_gates_have_non_empty_ids_and_descriptions() {
        let gates = [
            GovernanceGate::ArchEscape,
            GovernanceGate::ScopeWiden,
            GovernanceGate::ParallelDependency,
            GovernanceGate::SynthesisChild,
            GovernanceGate::UnsupportedFact,
            GovernanceGate::PassWithHardViolation,
            GovernanceGate::Protocol,
            GovernanceGate::CheckFail,
        ];
        for gate in gates {
            let id = gate.id();
            let desc = gate.description();
            assert!(!id.is_empty(), "gate {:?} has empty id", gate);
            assert!(
                id.starts_with("G-"),
                "gate {:?} id '{}' does not start with G-",
                gate,
                id
            );
            assert!(
                !desc.is_empty(),
                "gate {:?} id={} has empty description",
                gate,
                id
            );
            assert!(
                desc.len() > 10,
                "gate {:?} id={} description too short: '{}'",
                gate,
                id,
                desc
            );
        }
    }

    #[test]
    fn governance_layer_is_some_for_all_agent_operations() {
        for op in [
            NodeOperation::Specify,
            NodeOperation::Plan,
            NodeOperation::Execute,
            NodeOperation::Combine,
            NodeOperation::Verify,
        ] {
            assert!(
                governance_layer_for(op).is_some(),
                "operation {:?} has no governance layer",
                op
            );
        }
    }

    #[test]
    fn commit_has_no_governance_layer() {
        assert_eq!(governance_layer_for(NodeOperation::Commit), None);
    }

    #[test]
    fn display_implementations_are_readable() {
        // GovernanceLayer
        assert_eq!(format!("{}", GovernanceLayer::Arch), "Arch");
        assert_eq!(format!("{}", GovernanceLayer::Plan), "Plan");
        assert_eq!(format!("{}", GovernanceLayer::Execute), "Execute");
        assert_eq!(format!("{}", GovernanceLayer::Verify), "Verify");

        // GovernanceGate
        assert_eq!(format!("{}", GovernanceGate::ArchEscape), "G-ARCH-ESCAPE");
        assert_eq!(format!("{}", GovernanceGate::ScopeWiden), "G-SCOPE-WIDEN");
        assert_eq!(
            format!("{}", GovernanceGate::ParallelDependency),
            "G-PARALLEL-DEPENDENCY"
        );
        assert_eq!(
            format!("{}", GovernanceGate::SynthesisChild),
            "G-SYNTHESIS-CHILD"
        );
        assert_eq!(
            format!("{}", GovernanceGate::UnsupportedFact),
            "G-UNSUPPORTED-FACT"
        );
        assert_eq!(
            format!("{}", GovernanceGate::PassWithHardViolation),
            "G-PASS-WITH-HARD-VIOLATION"
        );
        assert_eq!(format!("{}", GovernanceGate::Protocol), "G-PROTOCOL");
        assert_eq!(format!("{}", GovernanceGate::CheckFail), "G-CHECK-FAIL");
    }

    #[test]
    fn display_implementations_are_consistent() {
        // NodeOperation (still lives in core, tested elsewhere)
        // GovernanceLayer — validate the standalone function matches expected Display
        assert_eq!(format!("{}", GovernanceLayer::Arch), "Arch");
        assert_eq!(format!("{}", GovernanceLayer::Plan), "Plan");
        assert_eq!(format!("{}", GovernanceLayer::Execute), "Execute");
        assert_eq!(format!("{}", GovernanceLayer::Verify), "Verify");
    }
}
