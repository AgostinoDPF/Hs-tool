import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PAYLOAD = {
    "taric": "4419 19 00 00", "hfdst_nr": "44",
    "hfdst_label": "Hout en houtwaren",
    "post": "Post 4419: houten keuken- en tafelgerei",
    "gn_code": "GN-code 4419 19: overige",
    "categorie": "Hout & decoratie", "confidence": 88,
    "redenering": "Bamboe dienblad voor tafelgebruik valt onder tafelgerei van hout.",
    "antidump_risico": False, "alternatief": None,
}

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        print("REQ model=%s thinking=%s heeft_output_config=%s" % (
            body.get("model"), body.get("thinking"), "output_config" in body), flush=True)
        print("REQ user=%r" % body["messages"][0]["content"][:120], flush=True)
        resp = {"id": "msg_1", "type": "message", "role": "assistant",
                "model": body.get("model"), "stop_reason": "end_turn",
                "stop_sequence": None, "content": [{"type": "text", "text": json.dumps(PAYLOAD)}],
                "usage": {"input_tokens": 10, "output_tokens": 10}}
        out = json.dumps(resp).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers()
        self.wfile.write(out)
    def log_message(self, *a): pass

HTTPServer(("127.0.0.1", 8799), H).serve_forever()
