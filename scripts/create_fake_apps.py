#!/usr/bin/env python3
"""Create placeholder instances that look like real projects (blog/html/api)
   Different name + different fake app per region. No nezha."""
import json, subprocess, base64

# 不同地区的"伪装"配置：name + 一个看起来像真实项目的简单 web 服务
# 用 http 模块起个简单 server，返回对应内容
placeholders = [
    {
        "metro": "fra",
        "name": "blog-fra",
        "port": "3000",
        "title": "My Travel Blog",
        "body": "Welcome to my travel blog. Latest posts from Europe.",
    },
    {
        "metro": "dal",
        "name": "html-static-dal",
        "port": "8080",
        "title": "Portfolio",
        "body": "Personal portfolio page. Coming soon.",
    },
    {
        "metro": "was",
        "name": "api-gateway-was",
        "port": "5000",
        "title": "API Gateway",
        "body": "Internal API gateway. Authentication required.",
    },
    {
        "metro": "sfo",
        "name": "landing-sfo",
        "port": "4000",
        "title": "Startup Landing",
        "body": "Launching soon. Sign up for early access.",
    },
]

def make_app(p):
    """Generate a simple http server returning a page"""
    js = f'''var h=require("http"),f=require("fs");
h.createServer(function(q,s){{
  if(q.url==="/health"){{s.writeHead(200);s.end("ok");return}}
  if(q.url==="/"){{s.writeHead(200,{{"Content-Type":"text/html"}});s.end("<!DOCTYPE html><html><head><title>{p['title']}</title></head><body style=font-family:sans-serif;padding:40px><h1>{p['title']}</h1><p>{p['body']}</p><p>Served by node on port {p['port']}</p></body></html>");return}}
  s.writeHead(404);s.end("not found")
}}).listen({p['port']},function(){{console.log("listening on {p['port']}")}});
setInterval(function(){{console.log("alive "+Date.now())}},300000)'''
    return js

eval_script = "eval(Buffer.from(process.env.APP,process.env.ENC).toString())"
args_json = json.dumps(["node", "-e", eval_script])

for p in placeholders:
    print(f"\n=== Creating {p['name']} in {p['metro']} ===")
    app_js = make_app(p)
    app_b64 = base64.b64encode(app_js.encode()).decode()
    
    cmd = [
        "unikraft", "instances", "create",
        "--name", p['name'],
        "--metro", p['metro'],
        "--image", "node",
        "--memory", "512MiB",
        "--vcpus", "1",
        "--autostart",
        "--restart", "always",
        "--scale-to-zero", "policy=off",
        f"--set=runtime.args={args_json}",
        "-e", f"APP={app_b64}",
        "-e", "ENC=base64",
        "-e", "TZ=Asia/Shanghai",
        "-e", f"PORT={p['port']}",
        "-e", "NODE_ENV=production",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    print(f"RC: {r.returncode}")
    for line in r.stdout.split('\n'):
        if any(k in line for k in ['name:', 'state:', 'memory:', 'private-ip:', 'error', 'reason:']):
            print(' ', line.strip())
    if r.stderr:
        print(f"STDERR: {r.stderr[-200:]}")
