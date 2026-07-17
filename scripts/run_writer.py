#!/usr/bin/env python3
"""Generate writer instance YAML with proper volume mount via --set"""
import base64, json, subprocess, sys

AGENT_JS = '/home/z/my-project/nezha-pure-node/agent.js'
with open(AGENT_JS, 'rb') as f:
    agent_b64 = base64.b64encode(f.read()).decode('ascii')

writer_script = 'require("fs").writeFileSync("/data/agent.js",Buffer.from(process.env.AGENT_B64,"base64"));console.log("WROTE",require("fs").statSync("/data/agent.js").size);process.exit(0);'

args_json = json.dumps(["-e", writer_script])

cmd = [
    "/home/z/.local/bin/unikraft", "instances", "create",
    "--name", "nezha-writer",
    "--metro", "sin",
    "--image", "node",
    "--memory", "512MiB",
    "--vcpus", "1",
    "--autostart",
    "--restart", "never",
    "--scale-to-zero", "policy=off",
    "-v", "nezha-data:/data",
    f"--set=runtime.args={args_json}",
    "-e", f"AGENT_B64={agent_b64}",
]
print("Running:", " ".join(cmd[:5]), "...", file=sys.stderr)
r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
print("STDOUT:", r.stdout[-2000:])
print("STDERR:", r.stderr[-500:])
print("RC:", r.returncode)
