from internal.agent.plan import parse_plan_from_text


def test_parse_plan_from_text() -> None:
    text = '{"steps":[{"id":"step_1","title":"t","type":"command","needs_approval":false,"command":"echo hi"}]}'
    plan = parse_plan_from_text(text)
    assert len(plan.steps) == 1
