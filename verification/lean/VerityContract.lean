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

end VerityContract
