"""Check the balance for the DeepSeek key in DEEPSEEK_API_KEY."""

import json
import os
from urllib.request import Request, urlopen

key = os.environ.get("DEEPSEEK_API_KEY")
if not key:
    raise SystemExit("Please set DEEPSEEK_API_KEY before running this script.")

request = Request(
    "https://api.deepseek.com/user/balance",
    headers={"Authorization": f"Bearer {key}"},
)
with urlopen(request, timeout=60) as response:
    print(json.dumps(json.load(response), ensure_ascii=False, indent=2))
