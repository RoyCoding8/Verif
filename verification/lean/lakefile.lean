import Lake
open Lake DSL

package verityReference where
  version := v!"0.1.0"

@[default_target]
lean_lib VerityContract

@[default_target]
lean_exe contractFixtures where
  root := `ContractFixtures