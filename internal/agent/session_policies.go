package agent

type VerifyPolicy struct {
	AutoVerify   bool
	Commands     []string
	RequireClean bool
}

type ApprovalPolicy struct {
	RequireForKinds []ToolKind
	RequireForTools []string
}

type PatchReviewPolicy struct {
	Mode string // off|request|auto
}

func DefaultVerifyPolicy() VerifyPolicy {
	return VerifyPolicy{
		AutoVerify: true,
		Commands:   []string{"make test"},
	}
}

func DefaultApprovalPolicy() ApprovalPolicy {
	return ApprovalPolicy{
		RequireForKinds: []ToolKind{ToolKindExec, ToolKindWrite},
	}
}
