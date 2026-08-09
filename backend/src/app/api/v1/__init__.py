"""v1 endpoints: classify and health.

Stage 2 ships POST /v1/classify plus the two health probes. GET /v1/rules is a
late Stage 3 endpoint and POST /v1/feedback is Stage 4; neither is stubbed here,
because a stub that returns 501 is a maintenance liability with no user.
"""
