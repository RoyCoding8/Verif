import Lake
open Lake DSL

package verityRefinement where
  version := v!"0.1.0"

@[default_target]
lean_lib VerityRefinement where
  roots := #[`RefinementContract, `FiniteModel, `FiniteWitness]
