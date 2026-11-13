import Init

namespace VerityRefinement

universe u

def Refines {Domain : Type u} (oldPre newPre oldGuarantee newGuarantee : Domain → Prop) : Prop :=
  (∀ x, oldPre x → newPre x) ∧
    ((∀ x, oldPre x → newGuarantee x → oldGuarantee x) ∧
      (∃ x, oldPre x))

end VerityRefinement
