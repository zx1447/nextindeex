#!/usr/bin/env python3
"""简单的 HTTP 服务，返回公益页面 + 健康检查端点
   用法: python3 server.py
   端口: 4567
"""
import http.server
import socketserver
import os
import json
import time

PORT = 4567
HTML_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html')
START_TIME = time.time()

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/' or path == '/index.html':
            self.serve_html()
        elif path == '/api/v1/status':
            self.serve_status()
        elif path == '/health' or path == '/healthz':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'ok')
        elif path == '/robots.txt':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'User-agent: *\nAllow: /\n')
        else:
            self.serve_html()  # 所有路径都返回首页

    def serve_html(self):
        try:
            with open(HTML_FILE, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(f'Server Error: {e}'.encode())

    def serve_status(self):
        uptime = time.time() - START_TIME
        status = {
            'status': 'online',
            'service': 'GreenLeaf Charity',
            'version': '1.0.0',
            'uptime': round(uptime, 2),
            'timestamp': int(time.time())
        }
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(status).encode())

    def log_message(self, format, *args):
        pass  # 不输出日志，避免噪音

if __name__ == '__main__':
    with socketserver.TCPServer(('0.0.0.0', PORT), Handler) as httpd:
        print(f'GreenLeaf Charity server running on port {PORT}')
        httpd.serve_forever()
