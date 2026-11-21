import Lean

namespace Verity.KaniVerdict

inductive Evidence where
  | valid
  | invalid
  deriving BEq, Repr

inductive Assertion where
  | passed
  | failed
  | other
  deriving BEq, Repr

inductive Probe where
  | reached
  | unreachable
  | other
  deriving BEq, Repr

inductive Exit where
  | zero
  | counterexample
  | other
  deriving BEq, Repr

inductive Error where
  | none
  | assertionFailure
  | other
  deriving BEq, Repr

inductive Verdict where
  | pass
  | assertionCounterexample
  | probeCounterexample
  | error
  deriving BEq, Repr

structure Observation where
  evidence : Evidence
  assertion : Assertion
  probe : Probe
  exit : Exit
  error : Error
  deriving Repr

def classify (observation : Observation) : Verdict :=
  match observation.evidence with
  | .invalid => .error
  | .valid => match observation.assertion, observation.probe, observation.exit, observation.error with
      | .failed, .reached, .counterexample, .assertionFailure => .assertionCounterexample
      | .failed, .unreachable, .counterexample, .assertionFailure => .assertionCounterexample
      | .passed, .unreachable, .zero, .none => .probeCounterexample
      | .passed, .reached, .zero, .none => .pass
      | _, _, _, _ => .error

theorem rejectsUntrustedEvidence (observation : Observation) :
    classify { observation with evidence := .invalid } = .error := by
  cases observation <;> rfl

theorem separatesAssertionCounterexample :
    classify ⟨.valid, .failed, .reached, .counterexample, .assertionFailure⟩ = .assertionCounterexample := by
  rfl

theorem separatesUnreachableProbe :
    classify ⟨.valid, .passed, .unreachable, .zero, .none⟩ = .probeCounterexample := by
  rfl

theorem passRequiresReachedProbe :
    classify ⟨.valid, .passed, .reached, .zero, .none⟩ = .pass := by
  rfl

def evidences : List Evidence := [.valid, .invalid]
def assertions : List Assertion := [.passed, .failed, .other]
def probes : List Probe := [.reached, .unreachable, .other]
def exits : List Exit := [.zero, .counterexample, .other]
def errors : List Error := [.none, .assertionFailure, .other]

def observations : List Observation :=
  evidences.flatMap fun evidence =>
    assertions.flatMap fun assertion =>
      probes.flatMap fun probe =>
        exits.flatMap fun exit =>
          errors.map fun error => ⟨evidence, assertion, probe, exit, error⟩

def evidenceIndex : Evidence → Nat
  | .valid => 0
  | .invalid => 1

def assertionIndex : Assertion → Nat
  | .passed => 0
  | .failed => 1
  | .other => 2

def probeIndex : Probe → Nat
  | .reached => 0
  | .unreachable => 1
  | .other => 2

def exitIndex : Exit → Nat
  | .zero => 0
  | .counterexample => 1
  | .other => 2

def errorIndex : Error → Nat
  | .none => 0
  | .assertionFailure => 1
  | .other => 2

def verdictCode : Verdict → String
  | .pass => "PASS"
  | .assertionCounterexample => "ASSERTION_COUNTEREXAMPLE"
  | .probeCounterexample => "PROBE_COUNTEREXAMPLE"
  | .error => "ERROR"

def observationIndex (observation : Observation) : Nat :=
  (((((evidenceIndex observation.evidence * 3 + assertionIndex observation.assertion) * 3 +
    probeIndex observation.probe) * 3 + exitIndex observation.exit) * 3) +
    errorIndex observation.error)

def render (observation : Observation) : String :=
  s!"{observationIndex observation}={verdictCode (classify observation)}"

end Verity.KaniVerdict

def main : IO Unit := IO.println (String.intercalate "\n" (Verity.KaniVerdict.observations.map Verity.KaniVerdict.render))
