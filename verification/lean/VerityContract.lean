import Lean
open Lean

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

structure ClaimRow where
  id : String
  required : Nat
  evidence : List Nat
  domain : Option Nat
  dependencies : List Nat
  deriving FromJson, Repr

structure FixtureInput where
  name : String
  roots : List Nat
  claims : List ClaimRow
  expectedAccepted : Bool
  expectedEffective : List Nat
  expectedJsError : Option String
  deriving FromJson, Repr

structure FixtureOutput where
  name : String
  accepted : Bool
  effective : List Nat
  deriving ToJson, Repr

def requiredLevel : Nat → Option Assurance
  | 0 => some .tested
  | 1 => some .bounded
  | 2 => some .formal
  | _ => none

def evidenceLevel : Nat → Option Assurance
  | 0 => some .tested
  | 1 => some .bounded
  | _ => none

def weakestList? : List Assurance → Option Assurance
  | [] => none
  | first :: rest => some (weakestWith first rest)

def evaluateFrom (remaining all : List ClaimRow) (done : List Assurance) :
    Option (List Assurance) := do
  match remaining with
  | [] => pure done
  | row :: rest =>
      let required ← requiredLevel row.required
      let evidence ← row.evidence.mapM evidenceLevel
      let direct ← weakestList? evidence
      let dependencies ← row.dependencies.mapM (fun index =>
        if index < done.length then done[index]? else none)
      let domainsCompatible := row.dependencies.all (fun index =>
        match all[index]?, done[index]? with
        | some dependency, some level =>
            level != .bounded || row.domain == dependency.domain
        | _, _ => false)
      if evidence.any (fun level => level == .bounded) && row.domain.isNone then
        none
      else if !domainsCompatible then
        none
      else
        let actual := weakestWith direct dependencies
        if supports actual required then
          evaluateFrom rest all (done ++ [actual])
        else
          none

def evaluateClaims (claims : List ClaimRow) : Option (List Assurance) :=
  evaluateFrom claims claims []

def evaluateFixture (fixture : FixtureInput) : Option (List Assurance) :=
  if fixture.roots.isEmpty ||
      fixture.roots.any (fun root => root ≥ fixture.claims.length) then
    none
  else
    evaluateClaims fixture.claims

def outputFixture (fixture : FixtureInput) : FixtureOutput :=
  match evaluateFixture fixture with
  | some effective =>
      { name := fixture.name
        accepted := true
        effective := effective.map rank }
  | none =>
      { name := fixture.name
        accepted := false
        effective := [] }

end VerityContract