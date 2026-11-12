import Lean
import VerityContract

open Lean

namespace VerityContract

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

open VerityContract

def main : IO Unit := do
  let source ← IO.FS.readFile "fixtures.json"
  let json ← match Json.parse source with
    | .ok json => pure json
    | .error error => throw <| IO.userError error
  let fixtures : List FixtureInput ← match fromJson? json with
    | .ok fixtures => pure fixtures
    | .error error => throw <| IO.userError error
  let outputs := fixtures.map outputFixture
  let expectationsMatch := fixtures.all (fun fixture =>
    let output := outputFixture fixture
    output.accepted == fixture.expectedAccepted &&
      output.effective == fixture.expectedEffective)
  if !expectationsMatch then
    throw <| IO.userError "Lean fixture disagrees with its declared expected result"
  IO.println (Json.compress (toJson outputs))