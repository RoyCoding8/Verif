import RefinementContract

namespace VerityDelegation

universe u

structure RevisionId (Digest Approval : Type) where
  digest : Digest
  approval : Approval
  deriving DecidableEq

structure FrozenRevision (Revision Claim : Type) (Domain : Type u) where
  revision : Revision
  claim : Claim
  precondition : Domain → Prop
  guarantee : Domain → Prop

structure Delegation (Revision Claim : Type) where
  predecessor : Revision
  successor : Revision
  claim : Claim

structure Issued {Revision Claim : Type} {Domain : Type u}
    (delegation : Delegation Revision Claim)
    (predecessor successor : FrozenRevision Revision Claim Domain) : Prop where
  predecessorBound : delegation.predecessor = predecessor.revision
  successorBound : delegation.successor = successor.revision
  predecessorClaimBound : delegation.claim = predecessor.claim
  successorClaimBound : delegation.claim = successor.claim
  semanticRefinement : VerityRefinement.Refines
    predecessor.precondition successor.precondition
    predecessor.guarantee successor.guarantee

theorem issue {Revision Claim : Type} {Domain : Type u}
    (delegation : Delegation Revision Claim)
    (predecessor successor : FrozenRevision Revision Claim Domain)
    (predecessorBound : delegation.predecessor = predecessor.revision)
    (successorBound : delegation.successor = successor.revision)
    (predecessorClaimBound : delegation.claim = predecessor.claim)
    (successorClaimBound : delegation.claim = successor.claim)
    (semanticRefinement : VerityRefinement.Refines
      predecessor.precondition successor.precondition
      predecessor.guarantee successor.guarantee) :
    Issued delegation predecessor successor :=
  ⟨predecessorBound, successorBound, predecessorClaimBound,
    successorClaimBound, semanticRefinement⟩

theorem issueSound {Revision Claim : Type} {Domain : Type u}
    {delegation : Delegation Revision Claim}
    {predecessor successor : FrozenRevision Revision Claim Domain}
    (issued : Issued delegation predecessor successor) :
    delegation.predecessor = predecessor.revision ∧
    delegation.successor = successor.revision ∧
    delegation.claim = predecessor.claim ∧
    delegation.claim = successor.claim ∧
    VerityRefinement.Refines predecessor.precondition successor.precondition
      predecessor.guarantee successor.guarantee := by
  exact ⟨issued.predecessorBound, issued.successorBound,
    issued.predecessorClaimBound, issued.successorClaimBound,
    issued.semanticRefinement⟩

theorem staleSuccessorDigestReplayRejected
    {Digest Approval Claim : Type} {Domain : Type u}
    {delegation : Delegation (RevisionId Digest Approval) Claim}
    {predecessor successor : FrozenRevision (RevisionId Digest Approval) Claim Domain}
    (differentDigest : delegation.successor.digest ≠ successor.revision.digest)
    (issued : Issued delegation predecessor successor) : False := by
  apply differentDigest
  exact congrArg RevisionId.digest issued.successorBound

theorem staleSuccessorApprovalReplayRejected
    {Digest Approval Claim : Type} {Domain : Type u}
    {delegation : Delegation (RevisionId Digest Approval) Claim}
    {predecessor successor : FrozenRevision (RevisionId Digest Approval) Claim Domain}
    (differentApproval : delegation.successor.approval ≠ successor.revision.approval)
    (issued : Issued delegation predecessor successor) : False := by
  apply differentApproval
  exact congrArg RevisionId.approval issued.successorBound

theorem staleClaimReplayRejected
    {Revision Claim : Type} {Domain : Type u}
    {delegation : Delegation Revision Claim}
    {predecessor successor : FrozenRevision Revision Claim Domain}
    (differentClaim : delegation.claim ≠ successor.claim)
    (issued : Issued delegation predecessor successor) : False := by
  apply differentClaim
  exact issued.successorClaimBound

end VerityDelegation
