import os
import http.server
import socketserver

PORT = int(os.environ.get("PORT", "8888"))
DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_deploy")
os.chdir(DIRECTORY)

handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(("127.0.0.1", PORT), handler) as httpd:
    print(f"Serving {DIRECTORY} on http://127.0.0.1:{PORT}")
    httpd.serve_forever()
