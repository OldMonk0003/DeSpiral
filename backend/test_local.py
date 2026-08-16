"""Local test harness for the Companion Lambda handler (BackEnd Epic A4).

Loads backend/.env, builds a dummy API Gateway-style event, invokes the
handler, and prints the status code + JSON body. Verifies Bedrock and
CockroachDB connectivity end-to-end.

    python backend/test_local.py
"""

import json
from pathlib import Path

from dotenv import load_dotenv

# Load environment BEFORE importing the handler so config is available.
load_dotenv(Path(__file__).resolve().parent / ".env")

from lambda_handler import lambda_handler  # noqa: E402


def main():
    test_event = {
        "user_token": "test_user_123",
        "user_prompt": "My heart is beating fast while reading this health article",
        "page_context": "Article about heart palpitations",
    }

    result = lambda_handler(test_event, None)

    print("Status Code:", result["statusCode"])
    try:
        parsed = json.loads(result["body"])
        print("Body:", json.dumps(parsed, indent=2))
    except (ValueError, TypeError):
        print("Body:", result["body"])


if __name__ == "__main__":
    main()
