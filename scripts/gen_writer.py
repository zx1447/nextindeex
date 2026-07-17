#!/usr/bin/env python3
"""Generate nezha-writer instance YAML using --set-file approach"""
import base64, json

AGENT_JS = '/home/z/my-project/nezha-pure-node/agent.js'
with open(AGENT_JS, 'rb') as f:
    agent_b64 = base64.b64encode(f.read()).decode('ascii')

writer_script = 'require("fs").writeFileSync("/data/agent.js",Buffer.from(process.env.AGENT_B64,"base64"));console.log("WROTE",require("fs").statSync("/data/agent.js").size);'

# Generate a JSON file that --set-file can use
set_data = {
    "name": "nezha-writer",
    "metro": "sin",
    "image": "node",
    "autostart": True,
    "restart": {"policy": "never"},
    "scale-to-zero": {"enabled": False, "policy": "off"},
    "resources": {"memory": "512MiB", "vcpus": 1},
    "volumes": [{"name": "nezha-data", "at": "/data"}],
    "runtime": {
        "args": ["-e", writer_script],
        "env": {"AGENT_B64": agent_b64}
    }
}

with open('/home/z/my-project/scripts/nezha-writer.json', 'w') as f:
    json.dump(set_data, f, indent=2)

print(f"JSON written, agent b64 size: {len(agent_b64)}")
