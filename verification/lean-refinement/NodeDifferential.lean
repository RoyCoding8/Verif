import Init

namespace VerityNodeDifferential

structure Binding where
  baseCommit : Nat
  baseManifest : Nat
  candidateCommit : Nat
  candidateManifest : Nat
  recipe : Nat
  oracle : Nat
  deriving DecidableEq, Repr

structure Approved where
  binding : Binding
  cases : List Nat
  deriving DecidableEq, Repr

structure Observation where
  id : Nat
  baseline : Nat
  candidate : Nat
  passed : Bool
  deriving DecidableEq, Repr

structure Receipt where
  binding : Binding
  observations : List Observation
  deriving DecidableEq, Repr

def accepted (approved : Approved) (receipt : Receipt) : Prop :=
  (receipt.binding = approved.binding ∧
    receipt.observations.map Observation.id = approved.cases) ∧
  (∀ observation ∈ receipt.observations,
    observation.passed = true ∧ observation.baseline = observation.candidate)

def acceptedCheck (approved : Approved) (receipt : Receipt) : Bool :=
  decide (receipt.binding = approved.binding) &&
  decide (receipt.observations.map Observation.id = approved.cases) &&
  receipt.observations.all fun observation =>
    observation.passed && decide (observation.baseline = observation.candidate)

theorem acceptedCheck_correct (approved : Approved) (receipt : Receipt) :
    acceptedCheck approved receipt = true ↔ accepted approved receipt := by
  simp [acceptedCheck, accepted, List.all_eq_true, and_assoc]

theorem acceptance_preserves_observations (approved : Approved) (receipt : Receipt)
    (accept : accepted approved receipt) :
    ∀ observation ∈ receipt.observations,
      observation.baseline = observation.candidate := by
  intro observation member
  exact (accept.2 observation member).2

theorem acceptance_binds_snapshots_recipe_and_oracle (approved : Approved) (receipt : Receipt)
    (accept : accepted approved receipt) : receipt.binding = approved.binding :=
  accept.1.1

def approvedBinding : Binding :=
  { baseCommit := 1, baseManifest := 11, candidateCommit := 2, candidateManifest := 22,
    recipe := 3, oracle := 4 }

def approvedDomain : Approved := { binding := approvedBinding, cases := [0, 1] }

def refactor : Receipt :=
  { binding := approvedBinding,
    observations := [{ id := 0, baseline := 10, candidate := 10, passed := true },
      { id := 1, baseline := 20, candidate := 20, passed := true }] }

def staleBaseline : Receipt :=
  { refactor with binding := { approvedBinding with baseManifest := 99 } }

def staleCandidateManifest : Receipt :=
  { refactor with binding := { approvedBinding with candidateManifest := 99 } }

def staleOracle : Receipt :=
  { refactor with binding := { approvedBinding with oracle := 99 } }

def incompleteInventory : Receipt :=
  { refactor with observations := [{ id := 0, baseline := 10, candidate := 10, passed := true }] }

def falsePositive : Receipt :=
  { binding := approvedBinding,
    observations := [{ id := 0, baseline := 10, candidate := 90, passed := true },
      { id := 1, baseline := 20, candidate := 20, passed := true }] }

theorem refactorAccepted : acceptedCheck approvedDomain refactor = true := by decide

theorem staleBaselineRejected : acceptedCheck approvedDomain staleBaseline = false := by decide

theorem staleCandidateManifestRejected : acceptedCheck approvedDomain staleCandidateManifest = false := by decide

theorem staleOracleRejected : acceptedCheck approvedDomain staleOracle = false := by decide

theorem incompleteInventoryRejected : acceptedCheck approvedDomain incompleteInventory = false := by decide

theorem explicitFalsePositiveRejected : acceptedCheck approvedDomain falsePositive = false := by decide

theorem refactorAcceptedAsProp : accepted approvedDomain refactor :=
  (acceptedCheck_correct approvedDomain refactor).mp refactorAccepted

#eval acceptedCheck approvedDomain refactor
#eval acceptedCheck approvedDomain staleBaseline
#eval acceptedCheck approvedDomain staleCandidateManifest
#eval acceptedCheck approvedDomain staleOracle
#eval acceptedCheck approvedDomain incompleteInventory
#eval acceptedCheck approvedDomain falsePositive

#print axioms acceptance_preserves_observations
#print axioms acceptance_binds_snapshots_recipe_and_oracle
#print axioms acceptedCheck_correct
#print axioms refactorAccepted
#print axioms refactorAcceptedAsProp
#print axioms staleBaselineRejected
#print axioms staleCandidateManifestRejected
#print axioms staleOracleRejected
#print axioms incompleteInventoryRejected
#print axioms explicitFalsePositiveRejected

end VerityNodeDifferential
