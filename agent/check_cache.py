#!/usr/bin/env python3
"""Cache-sanity check: submit each stage prompt as a non-batch single call,
then immediately retry. First call should create cache (>2048 creation tokens);
second should read cache (>2048 read tokens)."""
import os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
import deploy_agent as da

TESTS = [
    ("DISCOVERY_SYSTEM_PROMPT", "Base URL: https://example.com\n\nHomepage HTML (trimmed):\n<html><body><nav><a href='/menu'>Menu</a></nav></body></html>"),
    ("MENU_EXTRACTION_SYSTEM_PROMPT", "Restaurant: Test Diner\n\nMenu page text:\nBURGERS\nThe Classic .... 11.99\nBacon Cheeseburger .... 13.49"),
    ("MODIFIER_INFERENCE_SYSTEM_PROMPT", '{"restaurantType":"burger","items":[{"Menu Item Full Name":"The Classic","Menu Item Group":"Burgers","Menu Item Category":"Food"}]}'),
    ("BRANDING_TOKENS_SYSTEM_PROMPT", '{"url":"https://example.com","name":"Test Diner","restaurantType":"burger","html_snippet":"<html><head><meta name=\\"theme-color\\" content=\\"#8B6A4F\\"></head></html>"}'),
]

for name, user_msg in TESTS:
    sys_prompt = da._STAGE_PROMPTS[name]
    print(f"\n── {name} ──")
    for i in (1, 2):
        r = da._anthropic.messages.create(
            model=da.BATCH_MODEL,
            max_tokens=256,
            system=[{"type": "text", "text": sys_prompt, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_msg}],
        )
        u = r.usage
        print(f"  call {i}: input={u.input_tokens} creation={getattr(u,'cache_creation_input_tokens',0)} read={getattr(u,'cache_read_input_tokens',0)} output={u.output_tokens}")
        if i == 1:
            time.sleep(0.5)
