import Lean
import VerityContract

open Lean
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