import sys
import json
import os
import traceback
from playwright.sync_api import sync_playwright

_playwright = None
_browser = None
_page = None

def get_page():
    global _playwright, _browser, _page
    if _playwright is None:
        _playwright = sync_playwright().start()
        try:
            _browser = _playwright.chromium.connect_over_cdp("http://localhost:9222")
            contexts = _browser.contexts
            if contexts and len(contexts[0].pages) > 0:
                _page = contexts[0].pages[0]
            else:
                _page = _browser.new_page()
        except Exception as e:
            sys.stderr.write(f"CDP connection failed ({e}), launching system Chrome...\n")
            chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
            if os.path.exists(chrome_path):
                _browser = _playwright.chromium.launch(executable_path=chrome_path, headless=False)
            else:
                _browser = _playwright.chromium.launch(headless=False)
            _page = _browser.new_page()
    return _page

def send_response(response):
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()

def handle_request(req):
    method = req.get("method")
    msg_id = req.get("id")

    if method == "initialize":
        send_response({
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "browser",
                    "version": "1.0.0"
                }
            }
        })
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        send_response({
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "tools": [
                    {
                        "name": "browser_navigate",
                        "description": "Navigate to a URL using Playwright Chromium, take a screenshot, and return title and text snippet.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "url": {"type": "string", "description": "The URL to open, e.g. http://localhost:8080"}
                            },
                            "required": ["url"]
                        }
                    },
                    {
                        "name": "browser_click",
                        "description": "Click an element matching a CSS selector or text content on the active page.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "selector": {"type": "string", "description": "CSS selector or text content to click"}
                            },
                            "required": ["selector"]
                        }
                    },
                    {
                        "name": "browser_type",
                        "description": "Type text into an input element.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "selector": {"type": "string", "description": "CSS selector for input field"},
                                "text": {"type": "string", "description": "Text to type"}
                            },
                            "required": ["selector", "text"]
                        }
                    },
                    {
                        "name": "browser_eval",
                        "description": "Execute JavaScript code on the page.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "expression": {"type": "string", "description": "JavaScript snippet to evaluate"}
                            },
                            "required": ["expression"]
                        }
                    },
                    {
                        "name": "browser_get_content",
                        "description": "Get page title, URL, and body text of the active page.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {}
                        }
                    }
                ]
            }
        })
    elif method == "tools/call":
        params = req.get("params", {})
        tool_name = params.get("name")
        args = params.get("arguments", {})

        try:
            page = get_page()
            result_text = ""

            if tool_name == "browser_navigate":
                url = args.get("url", "http://localhost:8080")
                page.goto(url, wait_until="domcontentloaded", timeout=15000)
                title = page.title()
                body_text = page.inner_text("body")[:2000]
                
                screenshot_dir = r"C:\Users\rehan\.gemini\antigravity-ide\brain\0181d08c-70cf-4865-9b25-4c9732a1e275"
                os.makedirs(screenshot_dir, exist_ok=True)
                screenshot_path = os.path.join(screenshot_dir, "browser_screenshot.png")
                page.screenshot(path=screenshot_path)

                result_text = f"Navigated to: {url}\nTitle: {title}\nScreenshot: {screenshot_path}\n\nContent Snippet:\n{body_text}"

            elif tool_name == "browser_click":
                selector = args.get("selector")
                page.click(selector, timeout=5000)
                result_text = f"Clicked: '{selector}'. Active URL: {page.url}"

            elif tool_name == "browser_type":
                selector = args.get("selector")
                text = args.get("text")
                page.fill(selector, text, timeout=5000)
                result_text = f"Typed into '{selector}'."

            elif tool_name == "browser_eval":
                expr = args.get("expression")
                eval_res = page.evaluate(expr)
                result_text = f"Result: {json.dumps(eval_res, indent=2) if isinstance(eval_res, (dict, list)) else str(eval_res)}"

            elif tool_name == "browser_get_content":
                title = page.title()
                url = page.url
                body_text = page.inner_text("body")[:3000]
                result_text = f"URL: {url}\nTitle: {title}\n\nContent:\n{body_text}"

            else:
                result_text = f"Unknown tool: {tool_name}"

            send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": result_text
                        }
                    ]
                }
            })
        except Exception as e:
            err_msg = f"Error: {str(e)}\n{traceback.format_exc()}"
            sys.stderr.write(err_msg + "\n")
            send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": f"Error executing tool: {str(e)}"
                        }
                    ],
                    "isError": True
                }
            })
    else:
        if msg_id:
            send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {
                    "code": -32601,
                    "message": f"Method not found: {method}"
                }
            })

def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            handle_request(req)
        except Exception as e:
            sys.stderr.write(f"JSON parse error: {e}\n")

if __name__ == "__main__":
    main()
