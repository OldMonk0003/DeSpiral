#!/bin/bash
# Lambda Web Adapter entrypoint (set as the function Handler for the .zip
# managed-runtime deployment). LWA proxies invocations to this web server on
# 127.0.0.1:$PORT, so uvicorn MUST bind 0.0.0.0.
exec python3 -m uvicorn app:app --host 0.0.0.0 --port "${PORT:-8080}"
