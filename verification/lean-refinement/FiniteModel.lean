namespace RefinementFixture

inductive State where
  | oldSupported
  | oldNoGuarantee
  | newOnly
  | outside
  deriving DecidableEq, Repr

def OldPrecondition : State → Prop
  | .oldSupported => True
  | .oldNoGuarantee => True
  | .newOnly => False
  | .outside => False

def NewPrecondition : State → Prop
  | .oldSupported => True
  | .oldNoGuarantee => True
  | .newOnly => True
  | .outside => False

def EmptyOldPrecondition : State → Prop
  | _ => False

def BadNewPrecondition : State → Prop
  | .oldSupported => False
  | .oldNoGuarantee => True
  | .newOnly => True
  | .outside => False

def OldGuarantee : State → Prop
  | .oldSupported => True
  | .oldNoGuarantee => True
  | .newOnly => False
  | .outside => False

def NewGuarantee : State → Prop
  | .oldSupported => True
  | .oldNoGuarantee => False
  | .newOnly => True
  | .outside => False

end RefinementFixture
