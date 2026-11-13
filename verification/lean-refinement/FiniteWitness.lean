import RefinementContract
import FiniteModel

theorem finiteWitness :
    VerityRefinement.Refines (Domain := RefinementFixture.State)
      RefinementFixture.OldPrecondition
      RefinementFixture.NewPrecondition
      RefinementFixture.OldGuarantee
      RefinementFixture.NewGuarantee := by
  constructor
  · intro state oldPre
    cases state with
    | oldSupported => exact True.intro
    | oldNoGuarantee => exact True.intro
    | newOnly => cases oldPre
    | outside => cases oldPre
  constructor
  · intro state oldPre newGuarantee
    cases state with
    | oldSupported => exact True.intro
    | oldNoGuarantee => cases newGuarantee
    | newOnly => cases oldPre
    | outside => cases oldPre
  · exact ⟨.oldSupported, True.intro⟩

theorem newGuaranteeMayImproveOutsideOldDomain :
    ¬ (∀ state, RefinementFixture.NewGuarantee state → RefinementFixture.OldGuarantee state) := by
  intro unconditional
  have oldGuarantee := unconditional .newOnly True.intro
  cases oldGuarantee
