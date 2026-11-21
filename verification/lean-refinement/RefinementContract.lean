import Init

namespace VerityRefinement

universe u

def Refines {Domain : Type u} (oldPre newPre oldGuarantee newGuarantee : Domain → Prop) : Prop :=
  (∀ x, oldPre x → newPre x) ∧
    ((∀ x, oldPre x → newGuarantee x → oldGuarantee x) ∧
      (∃ x, oldPre x))

theorem refinesTrans {Domain : Type u} {p₀ p₁ p₂ q₀ q₁ q₂ : Domain → Prop}
    (first : Refines p₀ p₁ q₀ q₁) (second : Refines p₁ p₂ q₁ q₂) :
    Refines p₀ p₂ q₀ q₂ :=
  ⟨fun x h₀ => second.1 x (first.1 x h₀),
    fun x h₀ h₂ => first.2.1 x h₀ (second.2.1 x (first.1 x h₀) h₂),
    first.2.2⟩

end VerityRefinement
