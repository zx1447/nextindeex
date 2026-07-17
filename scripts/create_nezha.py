#!/usr/bin/env python3
"""Create nezha-sin instance with all correct settings"""
import base64, json, subprocess

# Loader: fetch agent.js from CDN
loader_js = 'require("https").get("https://cdn.jsdelivr.net/gh/zx1447/nextindeex@main/nezha-pure-node/agent.js",function(r){var d="";r.on("data",function(c){d+=c});r.on("end",function(){eval(d)})})'
loader_b64 = base64.b64encode(loader_js.encode()).decode()

# -e script: no quotes, uses process.env
eval_script = "eval(Buffer.from(process.env.LOADER,process.env.ENC).toString())"
args_json = json.dumps(["node", "-e", eval_script])

cmd = [
    "/home/z/.local/bin/unikraft", "instances", "create",
    "--name", "nezha-sin",
    "--metro", "sin",
    "--image", "node",
    "--memory", "512MiB",
    "--vcpus", "1",
    "--autostart",
    "--restart", "always",
    "--scale-to-zero", "policy=off",
    f"--set=runtime.args={args_json}",
    "-e", "NZ_SERVER=nz.zxydk1715.dpdns.org:443",
    "-e", "NZ_TLS=true",
    "-e", "NZ_CLIENT_SECRET=BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL",
    "-e", "NZ_UUID=c592af8b-b49f-e6cf-8f68-f3c57faec830",
    "-e", "TZ=Asia/Shanghai",
    "-e", f"LOADER={loader_b64}",
    "-e", "ENC=base64",
]
print(f"args_json: {args_json}")
r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
print("RC:", r.returncode)
print("STDOUT (last 600):", r.stdout[-600:])
print("STDERR:", r.stderr[-200:])
