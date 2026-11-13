import Init
namespace VerityContract

inductive Assurance where
  | tested
  | bounded
  | formal
  deriving DecidableEq, BEq, Repr

def rank : Assurance → Nat
  | .tested => 0
  | .bounded => 1
  | .formal => 2

def weakest (left right : Assurance) : Assurance :=
  if rank left ≤ rank right then left else right

def weakestWith (direct : Assurance) : List Assurance → Assurance
  | [] => direct
  | dependency :: rest => weakestWith (weakest direct dependency) rest

def supports (actual required : Assurance) : Bool :=
  decide (rank required ≤ rank actual)

def supportsAll (required : Assurance) : List Assurance → Bool
  | [] => true
  | dependency :: rest => supports dependency required && supportsAll required rest

theorem supportsWeakestExact (left right required : Assurance) :
    supports (weakest left right) required =
      (supports left required && supports right required) := by
  cases left <;> cases right <;> cases required <;> decide

theorem supportsWeakestWithExact (direct required : Assurance) (dependencies : List Assurance) :
    supports (weakestWith direct dependencies) required =
      (supports direct required && supportsAll required dependencies) := by
  induction dependencies generalizing direct with
  | nil =>
      rw [weakestWith.eq_1]
      rw [supportsAll]
      rw [Bool.and_true]
  | cons dependency rest ih =>
      rw [weakestWith.eq_2]
      rw [supportsAll]
      rw [ih]
      rw [supportsWeakestExact]
      exact Bool.and_assoc _ _ _
theorem formalDropsToBounded :
    weakest .formal .bounded = .bounded := by
  decide

theorem boundedDependencyBlocksFormal :
    supports (weakestWith .formal [.bounded]) .formal = false := by
  decide

theorem allFormalComponentsPreserveFormal :
    supports (weakestWith .formal [.formal, .formal]) .formal = true := by
  decide

theorem insufficientTestedEvidenceRejectsBounded :
    supports .tested .bounded = false := by
  decide

structure GateInput where
  authority : Bool
  budget : Bool
  contract : Bool
  receipt : Bool
  scope : Bool
  composition : Bool
  freshness : Bool
  verdict : Bool
  artifacts : Bool

def gateAuthorized (input : GateInput) : Prop :=
  input.authority = true ∧ input.budget = true ∧ input.contract = true ∧
  input.receipt = true ∧ input.scope = true ∧ input.composition = true ∧
  input.freshness = true ∧ input.verdict = true ∧ input.artifacts = true

def gate : Option GateInput → Bool
  | none => false
  | some input => input.authority && input.budget && input.contract && input.receipt &&
    input.scope && input.composition && input.freshness && input.verdict && input.artifacts

theorem gateExact (input : GateInput) : gate (some input) = true ↔ gateAuthorized input := by
  constructor
  · intro accepted
    change (input.authority && input.budget && input.contract && input.receipt && input.scope &&
      input.composition && input.freshness && input.verdict && input.artifacts) = true at accepted
    obtain ⟨accepted, artifacts⟩ := Bool.and_eq_true_iff.mp accepted
    obtain ⟨accepted, verdict⟩ := Bool.and_eq_true_iff.mp accepted
    obtain ⟨accepted, freshness⟩ := Bool.and_eq_true_iff.mp accepted
    obtain ⟨accepted, composition⟩ := Bool.and_eq_true_iff.mp accepted
    obtain ⟨accepted, scope⟩ := Bool.and_eq_true_iff.mp accepted
    obtain ⟨accepted, receipt⟩ := Bool.and_eq_true_iff.mp accepted
    obtain ⟨accepted, contract⟩ := Bool.and_eq_true_iff.mp accepted
    obtain ⟨authority, budget⟩ := Bool.and_eq_true_iff.mp accepted
    exact ⟨authority, budget, contract, receipt, scope, composition, freshness, verdict, artifacts⟩
  · intro authorized
    rcases authorized with ⟨authority, budget, contract, receipt, scope, composition, freshness, verdict, artifacts⟩
    have accepted := Bool.and_eq_true_iff.mpr ⟨authority, budget⟩
    have accepted := Bool.and_eq_true_iff.mpr ⟨accepted, contract⟩
    have accepted := Bool.and_eq_true_iff.mpr ⟨accepted, receipt⟩
    have accepted := Bool.and_eq_true_iff.mpr ⟨accepted, scope⟩
    have accepted := Bool.and_eq_true_iff.mpr ⟨accepted, composition⟩
    have accepted := Bool.and_eq_true_iff.mpr ⟨accepted, freshness⟩
    have accepted := Bool.and_eq_true_iff.mpr ⟨accepted, verdict⟩
    exact Bool.and_eq_true_iff.mpr ⟨accepted, artifacts⟩

theorem gateRefusesMissing : gate none = false := rfl

end VerityContract
